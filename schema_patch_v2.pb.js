/// <reference path="../pb_data/types.d.ts" />
//
// ============================================================================
// 【临时补丁钩子 S1】memberships 表 + invitations.revoked/revoked_at + 存量回填
// ============================================================================
// 用途：为「团队管理增强」（取消/删除邀请、退出/移出团队、多团队切换）铺 schema。
//
// ⚠️ 为什么是钩子而不是迁移（见 .workbuddy/memory/pb-pitfalls.md ①③）：
//    迁移在 PB 启动阶段执行，任一迁移 fatal → 进程退出 → 全站 502（8-31 已栽一次，
//    狂重启 137 次）。钩子加载失败只 log error，PB 照常启动，/api/health 仍 200。
//
// ⚠️ 写法铁律（pb-pitfalls ⑤）：
//    1) 全部逻辑内联在 routerAdd 回调里 —— JSVM 每路由独立作用域，
//       写在回调外的 function/const 在回调里是 undefined（实测 ReferenceError）。
//    2) 返回体只放纯原始值 / 纯字符串数组 —— e.json() 无法序列化含 Go 方法的对象
//       （塞 field 进去会 `json: cannot marshal from Go func()`，还会连带吞掉 save 结果）。
//    3) 查询参数用 e.request.url.query().get('tok')，不用 e.request.header.get。
//    4) 全程 try-catch，任何异常都 e.json(500,{...}) 而非裸抛。
//    5) 幂等 —— 重复调用只会返回 "已存在，跳过"，不会重复建表 / 重复回填。
//
// 部署与执行（一次性）：
//    sudo curl -sL -o /opt/pocketbase/pb_hooks/schema_patch_v2.pb.js \
//      https://huananju26.github.io/decoration-workbench/schema_patch_v2_<新名>.pb.js
//    sudo systemctl restart pocketbase && sleep 3
//    curl -s 'http://127.0.0.1:8090/api/patch/v2?tok=hjaj-patch-v2-20260831' | head -c 2000
//    # 确认 ok:true 且 match:true 之后：
//    sudo rm /opt/pocketbase/pb_hooks/schema_patch_v2.pb.js && sudo systemctl restart pocketbase
// ============================================================================

routerAdd('GET', '/api/patch/v2', (e) => {
  const log = [];
  try {
    // ---------- 0. 令牌校验 ----------
    let tok = '';
    try { tok = e.request.url.query().get('tok') || ''; } catch (eT) { tok = ''; }
    if (tok !== 'hjaj-patch-v2-20260831') {
      return e.json(403, { ok: false, err: 'bad tok' });
    }

    const usersCol = $app.findCollectionByNameOrId('users');
    const orgsCol = $app.findCollectionByNameOrId('organizations');
    if (!usersCol || !orgsCol) {
      return e.json(500, { ok: false, err: 'users/organizations 集合缺失' });
    }

    // ---------- A. memberships（多团队成员关系表） ----------
    // 语义：一行 = 一个 (user, org) 关系。status 描述当前状态，退出/移出不删行，
    //      重新加入复用同一行把 status 翻回 active（配合 (user_id,org_id) 唯一索引）。
    // 规则全 null：客户端一律不能直读直写，只能走 api_team.pb.js 的路由。
    let memCol = null;
    try { memCol = $app.findCollectionByNameOrId('memberships'); } catch (eA0) { memCol = null; }

    if (!memCol) {
      const nc = new Collection({
        name: 'memberships',
        type: 'base',
        listRule: null,
        viewRule: null,
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
          { name: 'user_id', type: 'relation', required: true, maxSelect: 1, collectionId: usersCol.id, cascadeDelete: true },
          { name: 'org_id', type: 'relation', required: true, maxSelect: 1, collectionId: orgsCol.id, cascadeDelete: true },
          // role 用 text 而非 select：角色清单还会扩（前端 ROLE_OPTIONS 已 7 种），
          // select 一旦候选值对不上就 400，而扩 select 值正是上次 502 的导火索。
          { name: 'role', type: 'text', max: 20 },
          { name: 'status', type: 'select', maxSelect: 1, values: ['active', 'left', 'removed'] },
          { name: 'joined_at', type: 'text', max: 30 },
          { name: 'invited_by', type: 'text', max: 40 },
          { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
          { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true }
        ]
      });
      $app.save(nc);
      log.push('A: memberships 集合已创建');
      memCol = $app.findCollectionByNameOrId('memberships');
    } else {
      log.push('A: memberships 集合已存在，跳过创建');
    }

    // ---------- A2. 索引（失败不致命，仅降级为「应用层去重」） ----------
    let idxNote = '';
    try {
      const cur = String(memCol.indexes || '');
      if (cur.indexOf('idx_mem_user_org') === -1) {
        memCol.indexes = [
          'CREATE UNIQUE INDEX `idx_mem_user_org` ON `memberships` (`user_id`, `org_id`)',
          'CREATE INDEX `idx_mem_org_status` ON `memberships` (`org_id`, `status`)'
        ];
        $app.save(memCol);
        memCol = $app.findCollectionByNameOrId('memberships');
        idxNote = 'created';
      } else {
        idxNote = 'exists';
      }
    } catch (eIdx) {
      idxNote = 'FAILED:' + (eIdx.message || String(eIdx));
    }
    log.push('A2: 索引 ' + idxNote);

    // ---------- B. invitations 加 revoked / revoked_at ----------
    // 「取消邀请」= revoked=true（链接立刻失效，记录留痕）；
    // 「删除邀请」= 真删记录（api_team.pb.js 里做）。两件事分开，是已拍板的决策 2。
    let invAdded = [];
    try {
      const invCol = $app.findCollectionByNameOrId('invitations');
      if (!invCol) throw new Error('invitations 集合缺失');
      // JSVM 里 fields.add() 只吃真实 Field 对象，借一个不落库的临时集合生成
      const probe = new Collection({
        name: '__probe_inv_v2',
        type: 'base',
        fields: [
          { name: 'revoked', type: 'bool' },
          { name: 'revoked_at', type: 'text', max: 30 }
        ]
      });
      ['revoked', 'revoked_at'].forEach((n) => {
        let has = null;
        try { has = invCol.fields.getByName(n); } catch (eB1) { has = null; }
        if (!has) {
          const f = probe.fields.getByName(n);
          if (f) { invCol.fields.add(f); invAdded.push(n); }
        }
      });
      if (invAdded.length) {
        $app.save(invCol);
        log.push('B: invitations 新增字段 ' + invAdded.join(','));
      } else {
        log.push('B: invitations 字段已存在，跳过');
      }
    } catch (eB) {
      log.push('B: 失败 ' + (eB.message || String(eB)));
    }

    // ---------- C. 存量回填：每个 users.org_id 非空的用户 → 一条 active membership ----------
    let usersWithOrg = [];
    try {
      usersWithOrg = $app.findRecordsByFilter('users', "org_id != ''", 'created', 2000, 0);
    } catch (eC0) {
      usersWithOrg = [];
      log.push('C: 查 users 失败 ' + (eC0.message || String(eC0)));
    }

    let created = 0;
    let skipped = 0;
    const failed = [];
    for (let i = 0; i < usersWithOrg.length; i++) {
      try {
        const u = usersWithOrg[i];
        const oid = String(u.get('org_id') || '');
        if (!oid) { continue; }
        let exist = null;
        try {
          exist = $app.findFirstRecordByFilter(
            'memberships',
            "user_id = '" + u.id + "' && org_id = '" + oid + "'"
          );
        } catch (eC1) { exist = null; }
        if (exist) { skipped++; continue; }

        const r = new Record(memCol);
        r.set('user_id', u.id);
        r.set('org_id', oid);
        r.set('role', String(u.get('role') || 'reader'));
        r.set('status', 'active');
        r.set('joined_at', String(u.get('created') || '').replace(' ', 'T').slice(0, 19));
        r.set('invited_by', '');
        $app.save(r);
        created++;
      } catch (eC2) {
        failed.push(String(eC2.message || eC2));
      }
    }
    log.push('C: 回填 created=' + created + ' skipped=' + skipped + ' failed=' + failed.length);

    // ---------- D. 条数比对（真绿判据：active 数 === 有 org_id 的用户数） ----------
    let memAll = [];
    try {
      memAll = $app.findRecordsByFilter('memberships', "id != ''", '', 5000, 0);
    } catch (eD) {
      memAll = [];
      log.push('D: 查 memberships 失败 ' + (eD.message || String(eD)));
    }
    let memActive = 0;
    for (let j = 0; j < memAll.length; j++) {
      if (String(memAll[j].get('status') || '') === 'active') memActive++;
    }

    // 回读 invitations 字段名，确认真落库（不能只看 save 没抛错）
    const invFieldNames = [];
    try {
      const iv = $app.findCollectionByNameOrId('invitations');
      const fs = iv.fields;
      for (let k = 0; k < fs.length; k++) {
        try { invFieldNames.push(String(fs[k].name)); } catch (eN) {}
      }
    } catch (eF) {}

    return e.json(200, {
      ok: true,
      log: log,
      users_with_org: usersWithOrg.length,
      backfill_created: created,
      backfill_skipped: skipped,
      backfill_failed: failed,
      mem_total: memAll.length,
      mem_active: memActive,
      // ⚠️ 唯一「真绿」判据：数量必须相等，不相等说明回填漏人
      match: memActive === usersWithOrg.length,
      inv_has_revoked: invFieldNames.indexOf('revoked') > -1,
      inv_has_revoked_at: invFieldNames.indexOf('revoked_at') > -1,
      inv_fields: invFieldNames
    });
  } catch (err) {
    return e.json(500, {
      ok: false,
      err: String(err.message || err),
      stack: String(err.stack || ''),
      log: log
    });
  }
});
