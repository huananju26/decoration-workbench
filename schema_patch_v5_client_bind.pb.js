// 【自动幂等补丁 S5】创建业主绑定两张表：
//   client_bind_codes  —— 公司的业主绑定码（org 唯一 + code 唯一）
//   client_bindings    —— 业主↔公司绑定关系（owner+org 唯一）
// 配套路由见 api_acct.pb.js（/api/client/*）。
//
// gate-allow-swallow: 所有 catch 只打日志、绝不重抛 —— 建表失败最坏只是功能缺失，
//   绝不能拖住 PB 启动（启动挂 = 全站 502）。
//
// 为什么走 cron（同 schema_patch_v3）：本 PB 版本 JSVM 无 onServe/onBootstrap；
//   文件顶层执行时 DB 未就绪会 nil panic；cron 每分钟触发，打完自注销。
//
// 🩸 踩坑记录（2026-09-02，两轮线上失败）：
//   第 1 轮：「先 find 再判空」写法永远进不了创建分支，日志假报「建表失败：sql: no rows in result set」。
//           → 教训：findCollectionByNameOrId 未命中可能 throw 也可能返回 null（视 PB 版本），
//             一律 try/catch，throw 当「不存在」（详见 pb-pitfalls ⑰）。
//   第 2 轮：改成 try/catch 后仍然建不出来（表还是 404 "Missing collection context"），
//           说明失败点不在 find，而在 **new Collection(...) / app.save(...)** 本身。
//   第 3 轮（本版）：不再赌单一写法 ——
//           ① 开头做环境诊断，把 JSVM 的真实行为打进日志（find 未命中的行为、Collection 是否可构造）
//           ② 建表走三级降级：带索引建表 → 不带索引建表 → 克隆已有 base 集合改名
//           ③ 建完复查「表存在 + 字段齐全」才算成功，避免建出空壳表还自注销
//
// 两张表 API 规则全部留空（null）= 仅 superuser 可访问 —— 与 access_requests 同策略，
//   客户端只能走钩子路由，杜绝越权。
//
// 验证命令（部署后约 1 分钟）：
//   sudo journalctl -u pocketbase -n 60 | grep schema_patch_v5
//   预期：两张表均已就位 / 已生效，cron 自我注销

cronAdd('schema_patch_v5_client_bind', '* * * * *', () => {
  var done = true;
  var LOG = function (s) { console.log('[schema_patch_v5] ' + s); };
  var WARN = function (s) { console.warn('[schema_patch_v5] ' + s); };

  try {
    var app = (typeof $app !== 'undefined' && $app) ? $app : null;
    if (!app) { WARN('拿不到 $app，稍后重试'); return; }

    /* 存在性检查：throw 与 null 都视为「不存在」 */
    var exists = function (name) {
      try {
        var c = app.findCollectionByNameOrId(name);
        return !!(c && c.id);
      } catch (e) {
        return false;
      }
    };

    /* 生成 15 位集合 id（PB 集合 id 字符集：小写字母 + 数字） */
    var rid = function () {
      var cs = 'abcdefghijklmnopqrstuvwxyz0123456789', s = '';
      for (var i = 0; i < 15; i++) s += cs.charAt(Math.floor(Math.random() * cs.length));
      return s;
    };

    /* 字段齐全性复查：防止建出「表在但字段为空」的空壳 */
    var fieldsOk = function (name, want) {
      try {
        var c = app.findCollectionByNameOrId(name);
        if (!c || !c.fields) return false;
        for (var i = 0; i < want.length; i++) {
          var f = c.fields.getByName(want[i]);
          if (!f) return false;
        }
        return true;
      } catch (e) {
        return false;
      }
    };

    var ok1 = exists('client_bind_codes');
    var ok2 = exists('client_bindings');

    if (ok1 && ok2) {
      /* 已存在，直接校字段并收尾 */
    } else {
      /* ── 0) 环境诊断：把 JSVM 的真实行为打进日志，下次不用猜 ── */
      try {
        var behave = 'unknown';
        try {
          var p = app.findCollectionByNameOrId('__probe_not_exist__');
          behave = p ? 'returned-object' : 'returned-null';
        } catch (pe) {
          behave = 'throw:' + ((pe && pe.message) || String(pe));
        }
        LOG('诊断：findCollectionByNameOrId(不存在的集合) => ' + behave);
        LOG('诊断：typeof Collection => ' + (typeof Collection));
        try {
          var pc = new Collection({ type: 'base', name: '__probe_col__' });
          LOG('诊断：new Collection({}) => ok；markAsNew=' + (typeof pc.markAsNew) + '；isNew=' + (typeof pc.isNew === 'function' ? String(pc.isNew()) : 'n/a'));
        } catch (pce) {
          LOG('诊断：new Collection({}) => 失败：' + ((pce && pce.message) || String(pce)));
        }
      } catch (pd) {
        WARN('诊断步骤异常（不影响建表）：' + ((pd && pd.message) || String(pd)));
      }

      /* organizations / users 集合 id 必须运行时解析 */
      var orgColId = '';
      try { orgColId = String(app.findCollectionByNameOrId('organizations').id || ''); } catch (e0) { orgColId = ''; }
      var usersColId = '_pb_users_auth_';
      try { usersColId = String(app.findCollectionByNameOrId('users').id || '_pb_users_auth_'); } catch (eu) { usersColId = '_pb_users_auth_'; }

      if (!orgColId) {
        WARN('organizations 集合缺失，稍后重试');
        done = false;
      } else {
        /* ── 建表：三级降级 ── */
        var build = function (name, fields, indexes, want) {
          /* A1：new Collection（带索引） */
          try {
            var nc = new Collection({
              id: rid(),
              type: 'base',
              name: name,
              fields: fields,
              indexes: indexes
            });
            if (typeof nc.markAsNew === 'function') nc.markAsNew();
            app.save(nc);
            if (exists(name)) return { ok: true, how: 'A1:new Collection(带索引)+markAsNew' };
            return { ok: false, msg: 'A1 保存未报错但复查不到表' };
          } catch (e1) {
            var m1 = 'A1失败：' + ((e1 && e1.message) || String(e1));
            /* A2：去掉索引再试（索引只是唯一性约束+性能，唯一性在路由里已用查询兜底） */
            try {
              var nc2 = new Collection({
                id: rid(),
                type: 'base',
                name: name,
                fields: fields,
                indexes: []
              });
              if (typeof nc2.markAsNew === 'function') nc2.markAsNew();
              app.save(nc2);
              if (exists(name)) return { ok: true, how: 'A2:new Collection(无索引)+markAsNew（唯一索引未建，靠路由层查询兜底）' };
              return { ok: false, msg: m1 + ' | A2 保存未报错但复查不到表' };
            } catch (e2) {
              var m2 = 'A2失败：' + ((e2 && e2.message) || String(e2));
              /* B：克隆已有 base 集合（access_requests）改名换字段 */
              try {
                var tpl = app.findCollectionByNameOrId('access_requests');
                if (!tpl) return { ok: false, msg: m1 + ' | ' + m2 + ' | B失败：模板集合 access_requests 不存在' };
                tpl.markAsNew();
                tpl.name = name;
                tpl.fields = fields;
                try { tpl.indexes = []; } catch (ib) { /* 索引不可写则忽略 */ }
                app.save(tpl);
                if (exists(name)) return { ok: true, how: 'B:克隆 access_requests 改名换字段' };
                return { ok: false, msg: m1 + ' | ' + m2 + ' | B 保存未报错但复查不到表' };
              } catch (e3) {
                return { ok: false, msg: m1 + ' | ' + m2 + ' | B失败：' + ((e3 && e3.message) || String(e3)) };
              }
            }
          }
        };

        if (!ok1) {
          try {
            var r1 = build('client_bind_codes', [
              { name: 'org', type: 'relation', required: true, collectionId: orgColId, maxSelect: 1 },
              { name: 'code', type: 'text', required: true }
            ], [
              'CREATE UNIQUE INDEX idx_cbc_org ON client_bind_codes (org)',
              'CREATE UNIQUE INDEX idx_cbc_code ON client_bind_codes (code)'
            ], ['org', 'code']);
            if (r1.ok) LOG('client_bind_codes 已创建（' + r1.how + '）');
            else { WARN('client_bind_codes 建表失败 → ' + r1.msg); }
          } catch (ee1) {
            WARN('client_bind_codes 建表异常：' + ((ee1 && ee1.message) || String(ee1)));
          }
        }

        if (!exists('client_bindings')) {
          try {
            var r2 = build('client_bindings', [
              { name: 'owner', type: 'relation', required: true, collectionId: usersColId, maxSelect: 1 },
              { name: 'org', type: 'relation', required: true, collectionId: orgColId, maxSelect: 1 }
            ], [
              'CREATE UNIQUE INDEX idx_cb_owner_org ON client_bindings (owner, org)'
            ], ['owner', 'org']);
            if (r2.ok) LOG('client_bindings 已创建（' + r2.how + '）');
            else { WARN('client_bindings 建表失败 → ' + r2.msg); }
          } catch (ee2) {
            WARN('client_bindings 建表异常：' + ((ee2 && ee2.message) || String(ee2)));
          }
        }
      }
    }

    /* 结论：以「复查存在 + 字段齐全」为准 */
    var has1 = exists('client_bind_codes');
    var has2 = exists('client_bindings');
    if (!has1) { WARN('client_bind_codes 仍不存在，下一轮重试'); done = false; }
    else if (!fieldsOk('client_bind_codes', ['org', 'code'])) { WARN('client_bind_codes 已存在但字段不全（org/code 缺失），请人工检查'); done = false; }
    if (!has2) { WARN('client_bindings 仍不存在，下一轮重试'); done = false; }
    else if (!fieldsOk('client_bindings', ['owner', 'org'])) { WARN('client_bindings 已存在但字段不全（owner/org 缺失），请人工检查'); done = false; }
    if (done) LOG('两张表均已就位且字段齐全');
  } catch (err) {
    WARN('顶层失败：' + ((err && err.message) || String(err)));
    done = false;
  }

  if (done) {
    try { cronRemove('schema_patch_v5_client_bind'); LOG('已生效，cron 自我注销'); }
    catch (e3) { WARN('cronRemove 失败（忽略）：' + ((e3 && e3.message) || String(e3))); }
  }
});
