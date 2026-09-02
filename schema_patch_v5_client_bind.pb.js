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
// 建表方式：new Collection({...})（官方 JS 迁移同款写法，types.d.ts 绑定构造器；
//   若该上下文没绑 Collection，会打 warn 并等下一轮重试）。
// 两张表 API 规则全部留空（null）= 仅 superuser 可访问 —— 与 access_requests 同策略，
//   客户端只能走钩子路由，杜绝越权。
//
// 验证命令（部署后约 1 分钟）：
//   sudo journalctl -u pocketbase -n 50 | grep schema_patch_v5
//   预期：client_bind_codes 已创建 / client_bindings 已创建 / cron 自我注销

cronAdd('schema_patch_v5_client_bind', '* * * * *', () => {
  var done = true;
  try {
    var app = (typeof $app !== 'undefined' && $app) ? $app : null;
    if (!app) { console.warn('[schema_patch_v5] 拿不到 $app，稍后重试'); return; }
    if (typeof Collection === 'undefined') {
      console.warn('[schema_patch_v5] 当前 JSVM 未绑定 Collection 构造器，建表不可用');
      return; /* 不置 done，也不再无意义重试 —— 但保留 cron 便于人工排查 */
    }

    /* organizations 集合 id 需要运行时解析（不能写死） */
    var orgColId = '';
    try { orgColId = String(app.findCollectionByNameOrId('organizations').id || ''); } catch (e0) { orgColId = ''; }
    if (!orgColId) { console.warn('[schema_patch_v5] organizations 集合缺失，稍后重试'); done = false; }
    else {
      /* ── 1) client_bind_codes ── */
      try {
        var c1 = app.findCollectionByNameOrId('client_bind_codes');
        if (!c1) {
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
          done = false;
        }
      } catch (e1) {
        console.warn('[schema_patch_v5] client_bind_codes 建表失败：' + ((e1 && e1.message) || String(e1)));
        done = false;
      }

      /* ── 2) client_bindings ── */
      try {
        var c2 = app.findCollectionByNameOrId('client_bindings');
        if (!c2) {
          var usersColId = String(app.findCollectionByNameOrId('users').id || '_pb_users_auth_');
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
          done = false;
        }
      } catch (e2) {
        console.warn('[schema_patch_v5] client_bindings 建表失败：' + ((e2 && e2.message) || String(e2)));
        done = false;
      }
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
