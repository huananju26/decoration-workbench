// 【自动幂等补丁 S5】创建业主绑定两张表：
//   client_bind_codes  —— 公司的业主绑定码（org 唯一 + code 唯一）
//   client_bindings    —— 业主↔公司绑定关系（owner+org 唯一）
// 配套路由见 api_acct.pb.js（/api/client/*）。
//
// gate-allow-swallow: 所有 catch 只打日志、绝不重抛 —— 建表失败最坏只是功能缺失，
//   绝不能拖住 PB 启动（启动挂 = 全站 502）。
//
// 为什么走 cron（同 schema_patch_v3，详见其头部注释）：
//   本 PB 版本 JSVM 无 onServe/onBootstrap；文件顶层执行时 DB 未就绪会 nil panic；
//   cron 每分钟触发，打完自注销。
//
// 🩸 踩坑（2026-09-02 首次上线即失败，每分钟刷 2 条「建表失败：sql: no rows in result set」）：
//   **app.findCollectionByNameOrId(name) 查不到时会 throw raw sql.ErrNoRows**，
//   不是返回 null！所以「var c = find(); if(!c){ new Collection(...) }」这种写法
//   永远不会进 if —— 异常直接被外层 catch 吞掉，看起来像「建表失败」其实压根没建。
//   JS 里绝不能写 `find(...) || new Collection(...)`（JSVM 不会把 error 转成 null）。
//   正确写法：存在性检查单独包 try/catch，throw 一律视为「不存在」。
//
// 建表方式：new Collection({...})（官方 JS 迁移同款写法，types.d.ts 绑定构造器）。
//   若该上下文没绑 Collection，会明确打 warn（与「建表失败」区分开）。
// 两张表 API 规则全部留空（null）= 仅 superuser 可访问 —— 与 access_requests 同策略，
//   客户端只能走钩子路由，杜绝越权。
//
// 验证命令（部署后约 1 分钟）：
//   sudo journalctl -u pocketbase -n 50 | grep schema_patch_v5
//   预期：client_bind_codes 已创建 / client_bindings 已创建 / 已生效，cron 自我注销

cronAdd('schema_patch_v5_client_bind', '* * * * *', () => {
  var done = true;
  try {
    var app = (typeof $app !== 'undefined' && $app) ? $app : null;
    if (!app) { console.warn('[schema_patch_v5] 拿不到 $app，稍后重试'); return; }

    /* 存在性检查：未命中会 throw（sql: no rows in result set），throw 一律当「不存在」 */
    var exists = function (name) {
      try {
        var c = app.findCollectionByNameOrId(name);
        return !!(c && c.id);
      } catch (e) {
        return false;
      }
    };

    var orgColId = '';
    try { orgColId = String(app.findCollectionByNameOrId('organizations').id || ''); } catch (e0) { orgColId = ''; }
    if (!orgColId) { console.warn('[schema_patch_v5] organizations 集合缺失，稍后重试'); done = false; }
    else {
      /* ── 1) client_bind_codes ── */
      if (exists('client_bind_codes')) {
        /* 已存在，跳过 */
      } else if (typeof Collection === 'undefined') {
        console.warn('[schema_patch_v5] 当前 JSVM 未绑定 Collection 构造器，无法建表');
        done = false;
      } else {
        try {
          var nc1 = new Collection({
            type: 'base',
            name: 'client_bind_codes',
            fields: [
              { name: 'org', type: 'relation', required: true, collectionId: orgColId, maxSelect: 1 },
              { name: 'code', type: 'text', required: true }
            ],
            indexes: [
              'CREATE UNIQUE INDEX idx_cbc_org ON client_bind_codes (org)',
              'CREATE UNIQUE INDEX idx_cbc_code ON client_bind_codes (code)'
            ]
          });
          app.save(nc1);
          console.log('[schema_patch_v5] client_bind_codes 已创建');
        } catch (e1) {
          console.warn('[schema_patch_v5] client_bind_codes 建表失败：' + ((e1 && e1.message) || String(e1)));
        }
      }

      /* ── 2) client_bindings ── */
      if (exists('client_bindings')) {
        /* 已存在，跳过 */
      } else if (typeof Collection === 'undefined') {
        console.warn('[schema_patch_v5] 当前 JSVM 未绑定 Collection 构造器，无法建表');
        done = false;
      } else {
        try {
          var usersColId = '_pb_users_auth_';
          try { usersColId = String(app.findCollectionByNameOrId('users').id || '_pb_users_auth_'); } catch (eu) { usersColId = '_pb_users_auth_'; }
          var nc2 = new Collection({
            type: 'base',
            name: 'client_bindings',
            fields: [
              { name: 'owner', type: 'relation', required: true, collectionId: usersColId, maxSelect: 1 },
              { name: 'org', type: 'relation', required: true, collectionId: orgColId, maxSelect: 1 }
            ],
            indexes: [
              'CREATE UNIQUE INDEX idx_cb_owner_org ON client_bindings (owner, org)'
            ]
          });
          app.save(nc2);
          console.log('[schema_patch_v5] client_bindings 已创建');
        } catch (e2) {
          console.warn('[schema_patch_v5] client_bindings 建表失败：' + ((e2 && e2.message) || String(e2)));
        }
      }

      /* 结论以「复查是否真的存在」为准，不靠创建过程有没有报错 */
      var ok1 = exists('client_bind_codes');
      var ok2 = exists('client_bindings');
      if (!ok1) { console.warn('[schema_patch_v5] client_bind_codes 仍未创建，下一轮重试'); done = false; }
      if (!ok2) { console.warn('[schema_patch_v5] client_bindings 仍未创建，下一轮重试'); done = false; }
      if (ok1 && ok2) { console.log('[schema_patch_v5] 两张表均已就位'); }
    }
  } catch (err) {
    console.warn('[schema_patch_v5] 顶层失败：' + ((err && err.message) || String(err)));
    done = false;
  }
  if (done) {
    try { cronRemove('schema_patch_v5_client_bind'); console.log('[schema_patch_v5] 已生效，cron 自我注销'); }
    catch (e3) { console.warn('[schema_patch_v5] cronRemove 失败（忽略）：' + ((e3 && e3.message) || String(e3))); }
  }
});
