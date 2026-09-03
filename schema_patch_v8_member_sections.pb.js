// 【schema_patch_v8】给 memberships 加 sections 字段（成员版块级权限，#447）
//
// 背景：装修工作台的「权限管理 → 编辑权限」弹窗此前**只写 localStorage**
//       （xzgz_team_perms[org:uid]）。后果：管理员给张三勾掉「台账」，
//        张三那边一点变化都没有 —— 权限存在管理员自己的浏览器里，
//        既不同步给本人，其它管理员也看不到。用户报「勾选或取消不起作用」，
//        根因就在这里（前端还有一个次因：四个项目管理子板块走的是四维权限
//        myProjectPerms()，压根没读 sections，勾了也白勾 —— 已一并修）。
//
// 本补丁：给 memberships 加一个 sections 字段，让「版块级权限」随成员关系落库，
//        谁登录都读到同一份。取值 = SECTION_EDIT_ORDER 的 22 个 key 的子集。
//
// 写法沿用 v7 的三条纪律（勿改回）：
//   ① 体检按**字段名**（fields.getByName），不数 fields.length（系统字段会凑数）
//   ② 钩子顶层不能在 DB 就绪前碰 schema → 一律 cronAdd + 达标后 cronRemove
//   ③ 每一步独立 try/catch，失败要出声（不能静默吞掉后假报成功）
//
// 字段类型：优先 JSONField（结构化数组）；构造器不可用时降级 TextField(max:0 = 不限长)
//          —— 路由层两种都能读（见 api_team_v1.js 的 normSections）。

cronAdd("schema_patch_v8", "* * * * *", () => {
  var app = (typeof $app !== "undefined" && $app) ? $app : null;
  if (!app) { console.warn("[sp_v8] 拿不到 $app，稍后重试"); return; }

  var run = function (app) {
    var out = { v: 8, ok: false, errors: [] };
    function L(s) { try { console.log("[sp_v8] " + s); } catch (e) {} }
    function E(s) { out.errors.push(String(s)); try { console.log("[sp_v8] ERR " + s); } catch (e) {} }

    var col = null;
    try { col = app.findCollectionByNameOrId("memberships"); } catch (e) { col = null; }
    if (!col) { E("memberships 集合不存在（成员体系未就绪），稍后重试"); return out; }

    /* 已存在且类型可接受 → 直接达标 */
    function curType() {
      try {
        var f = col.fields.getByName("sections");
        return f ? String(f.type) : "";
      } catch (e) { return ""; }
    }
    var t = curType();
    if (t === "json" || t === "text") { out.ok = true; L("memberships.sections 已存在（" + t + "），无需改动"); return out; }
    if (t) { E("memberships.sections 已存在但类型异常（" + t + "），需人工确认后再处理"); return out; }

    var made = false;
    if (typeof JSONField === "function") {
      try { col.fields.add(new JSONField({ name: "sections", maxSize: 2000000 })); made = true; }
      catch (e1) { E("JSONField 添加失败：" + ((e1 && e1.message) || String(e1))); }
    }
    if (!made && typeof TextField === "function") {
      try {
        col.fields.add(new TextField({ name: "sections", max: 0 }));   // max:0 = 不限长
        made = true;
        L("JSONField 不可用，已降级为 TextField 存储 JSON 字符串");
      } catch (e2) { E("TextField 兜底添加失败：" + ((e2 && e2.message) || String(e2))); }
    }
    if (!made) { E("JSONField / TextField 均不可用，字段加不上"); return out; }

    try { app.save(col); L("memberships.sections 字段已添加"); }
    catch (e3) { E("字段保存失败：" + ((e3 && e3.message) || String(e3))); return out; }

    if (curType()) { out.ok = true; L("复查通过，cron 自我注销"); }
    else { E("保存后复查仍取不到字段"); }
    return out;
  };

  var out = null;
  try { out = run(app); }
  catch (err) { console.warn("[sp_v8] 例程异常（下轮重试）：" + ((err && err.message) || String(err))); return; }
  if (out && out.ok) {
    try { cronRemove("schema_patch_v8"); console.log("[sp_v8] 已自我注销"); }
    catch (e2) { console.warn("[sp_v8] cronRemove 失败（忽略）：" + ((e2 && e2.message) || String(e2))); }
  } else {
    console.warn("[sp_v8] 尚未就位，1 分钟后重试（errors=" + ((out && out.errors.length) || 0) + "）");
  }
});
