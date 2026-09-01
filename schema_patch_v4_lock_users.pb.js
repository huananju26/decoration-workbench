// 【自动幂等补丁 S4】锁死 users 集合的游客 Create 规则，堵住 PB 原生 signup 绕过邮箱验证的漏洞。
//
// gate-allow-swallow: 本文件所有 catch 一律只打日志、绝不重抛 —— schema 补丁失败最坏
//   只是功能缺失，绝不能拖住 PB 启动（启动挂 = 全站 502）。这与业务路由里
//   「校验被静默绕过」是两种性质，故向静态门禁（test_pb_hook_static.js 规则⑤）显式声明豁免。
//
// 触发原因（2026-09-01 实测）：
//   游客直连 POST /api/collections/users/records（只给 email/password）即 HTTP=200 建出用户，
//   完全绕过 /api/auth/register 的「邮箱验证码」前置关（防绕过形同虚设）。
//   同理 api_multiorg_v1.js 的 register 钩子用 $app.save(user) 服务端落库，不受集合 API Rule 约束，
//   所以锁 createRule 不影响正常注册流程（自定义路由一律走 $app.save，绕过 API Rule）。
//
// 为什么不用迁移：生产上 collections 已存在，改文件对存量库无效；且迁移异常 = 全站 502。
// 为什么不用 onServe/onBootstrap：实测本 PB 版本的 JSVM **根本没有这两个函数**
//   （打印 globalThis 全部符号，注册类只有 routerAdd / cronAdd / cronRemove）。
// 为什么不用文件顶层代码：顶层确实会在启动时执行，但那一刻 $app 的 DB 还没就绪，
//   调 findCollectionByNameOrId 直接 nil pointer panic（实测）。
// → 唯一可靠的「启动后执行」时机是 cronAdd，打完补丁用 cronRemove 自我注销。
//
// ⚠️ PB JSVM 注意（详见 .workbuddy/memory/pb-pitfalls.md）：
//   · 每个回调独立上下文 → 本文件逻辑全部内联，无顶层 function/const 声明
//   · createRule 是集合对象的属性（不是字段），直接赋值后 $app.save(collection)
//   · 全程 try-catch：cron 回调抛异常只会打日志，不会影响服务

cronAdd('schema_patch_v4_lock_users', '* * * * *', () => {
  var done = true;
  try {
    var app = (typeof $app !== 'undefined' && $app) ? $app : null;
    if (!app) {
      console.warn('[schema_patch_v4] 拿不到 $app，稍后重试');
      return;
    }
    var c = app.findCollectionByNameOrId('users');
    if (!c) { console.warn('[schema_patch_v4] 跳过：users 集合不存在'); return; }

    // null / '' / undefined 都代表「仅 superuser 可创建」= 游客已禁止，无需改动
    var alreadyLocked = (c.createRule === null || c.createRule === '' || c.createRule === undefined);
    if (alreadyLocked) {
      console.log('[schema_patch_v4] users.createRule 已是禁止态（null/空），无需改动');
    } else {
      c.createRule = null;
      app.save(c);
      console.log('[schema_patch_v4] users.createRule 已锁死为 null（禁止游客直接创建用户，仅 superuser / 服务端可建）');
      done = false; /* 本轮有改动，等下轮确认后再注销 */
    }
  } catch (err) {
    console.warn('[schema_patch_v4] 顶层失败：' + ((err && err.message) || String(err)));
    done = false;
  }
  /* 已是禁止态（或已锁好下一轮确认）→ 补丁不再需要，自我注销，避免每分钟空转 */
  if (done) {
    try { cronRemove('schema_patch_v4_lock_users'); console.log('[schema_patch_v4] 已生效，cron 自我注销'); }
    catch (e3) { console.warn('[schema_patch_v4] cronRemove 失败（忽略）：' + ((e3 && e3.message) || String(e3))); }
  }
});
