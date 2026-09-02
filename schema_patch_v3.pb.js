// 【自动幂等补丁 S3】把 invitations.role / access_requests.role / users.role 三处 select
// 候选值统一扩为 8 值并集（admin / member / pm / designer / finance / purchaser / qa / reader）。
//
// gate-allow-swallow: 本文件所有 catch 一律只打日志、绝不重抛 —— schema 补丁失败最坏
//   只是功能缺失，绝不能拖住 PB 启动（启动挂 = 全站 502）。这与业务路由里
//   「校验被静默绕过」是两种性质，故向静态门禁（test_pb_hook_static.js 规则⑤）显式声明豁免。
//
// 触发原因（2026-08-31 实测）：
//   邀请「项目经理(pm)」→ 生成邀请码成功 → 员工拿码提交加入申请时 400
//   {"role":{"code":"validation_invalid_value"}}。
//   当年 role_patch.pb.js 只把 invitations.role 扩成 8 值，漏了另外两处：
//     ① access_requests.role 仍是 ['admin','member']（1790000006）
//        → 员工提交加入申请时写 inv.get('role')='pm' 就 400
//     ② users.role 仍是 ['admin','member']（1790000001）
//        → 管理员点「通过」写回 users.role='pm' 再次 400
//        → 「改成员角色」/api/org/set-role 写 pm/designer/... 全部 400
//        → api_team.pb.js 用 'reader' 兜底同样 400
//   即：除 admin/member 外，6 种角色在邀请、审核、改角色三个入口全线失效。
//
// 为什么不用迁移：生产上 1790000006 已跑过，改文件对存量库无效；且迁移异常 = 全站 502。
// 为什么不用 onServe/onBootstrap：实测本 PB 版本的 JSVM **根本没有这两个函数**
//   （打印 globalThis 全部 127 个符号，注册类只有 routerAdd / cronAdd / cronRemove）。
// 为什么不用文件顶层代码：顶层确实会在启动时执行，但那一刻 $app 的 DB 还没就绪，
//   调 findCollectionByNameOrId 直接 nil pointer panic（实测）。
// → 唯一可靠的「启动后执行」时机是 cronAdd，打完补丁用 cronRemove 自我注销。
//
// ⚠️ PB JSVM 注意（详见 .workbuddy/memory/pb-pitfalls.md）：
//   · 每个回调独立上下文 → 本文件逻辑全部内联，无顶层 function/const 声明
//   · select 候选值挂在 field.values（普通 JS 数组），不是 field.options
//   · 全程 try-catch：cron 回调抛异常只会打日志，不会影响服务

cronAdd('schema_patch_v3', '* * * * *', () => {
  var done = true;
  try {
    var app = (typeof $app !== 'undefined' && $app) ? $app : null;
    if (!app) {
      console.warn('[schema_patch_v3] 拿不到 $app，稍后重试');
      return;
    }
    var want = ['admin', 'member', 'pm', 'designer', 'finance', 'purchaser', 'qa', 'reader'];
    /* users.role 同样只有 ['admin','member']（来自 1790000001），而 /api/org/set-role
       会按前端 ROLE_OPTIONS 写入 pm/designer/...，api_team.pb.js 还用 'reader' 兜底
       → 不改这里，「改成员角色」和「邀请非 admin 的人通过审核」都会 400。 */
    var cols = ['invitations', 'access_requests', 'users'];
    for (var i = 0; i < cols.length; i++) {
      try {
        var c = app.findCollectionByNameOrId(cols[i]);
        /* ⚠️ 跳过 ≠ 达成：集合不存在 / 无 role 字段时目标态未确认，必须把 done 置 false，
           否则三表全部没找到也会打印「已生效」骗人（2026-09-02 踩到，详见 pb-pitfalls ⑭）。 */
        if (!c) { console.warn('[schema_patch_v3] 跳过 ' + cols[i] + '：集合不存在'); done = false; continue; }
        var f = c.fields.getByName('role');
        if (!f) { console.warn('[schema_patch_v3] 跳过 ' + cols[i] + '：无 role 字段'); done = false; continue; }

        var cur = [];
        if (Array.isArray(f.values)) cur = f.values.slice();
        else if (f.options && Array.isArray(f.options.values)) cur = f.options.values.slice();

        var add = [];
        for (var k = 0; k < want.length; k++) {
          if (cur.indexOf(want[k]) < 0) add.push(want[k]);
        }
        if (!add.length) continue; /* 已完整，跳过 */

        if (Array.isArray(f.values)) f.values = cur.concat(add);
        else if (f.options && Array.isArray(f.options.values)) f.options.values = cur.concat(add);
        else f.values = cur.concat(add);

        app.save(c);
        console.log('[schema_patch_v3] ' + cols[i] + '.role 已扩展：+' + add.join(','));
        done = false; /* 本轮有改动，等下轮确认后再注销 */
      } catch (e2) {
        console.warn('[schema_patch_v3] ' + cols[i] + ' 处理失败：' + ((e2 && e2.message) || String(e2)));
        done = false;
      }
    }
  } catch (err) {
    console.warn('[schema_patch_v3] 顶层失败：' + ((err && err.message) || String(err)));
    done = false;
  }
  /* 全部字段都已是完整候选值 → 补丁不再需要，自我注销，避免每分钟空转 */
  if (done) {
    try { cronRemove('schema_patch_v3'); console.log('[schema_patch_v3] 已生效，cron 自我注销'); }
    catch (e3) { console.warn('[schema_patch_v3] cronRemove 失败（忽略）：' + ((e3 && e3.message) || String(e3))); }
  }
});
