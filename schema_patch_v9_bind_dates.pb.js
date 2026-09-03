// 【schema_patch_v9 · 补建日期字段】client_bind_codes / client_bindings 缺 created / updated
//
// 由来（#451）：线上绑定弹窗报「读取我的绑定列表失败：invalid sort field "created"（HTTP 400）」，
//   管理员视角的绑定码蓝框也随之消失（/api/client/bindcode 同样走 -created 排序 → 同样 400
//   → 前端 catch 后降级到 owner 视角 → 又 400 → 弹窗只剩一句红色报错）。
//
// 真因（本地 PocketBase 0.40.1 实测，见 /tmp/pbsort 探针，结论已写进 pb-pitfalls ㉖）：
//   **JSVM 里 `new Collection({type:'base', name, fields:[], indexes:[]})` 建出来的集合
//     只有 `id` 一个字段 —— 系统字段 created / updated 不会自动补上。**
//   之后 `fields.add(new TextField(...))` 只加自定义字段，于是这两张表实际字段是
//   「id + 自定义」，既没有 created 也没有 updated。
//   其他集合（users / organizations 等）是 PB 内置或后台建的，自带 created/updated，
//   所以全站只有这两张表的 `-created` 排序炸 —— 这是「为什么别处都好好的」的答案。
//
//   实测记录（勿推翻）：
//     空壳建表后字段 = [id]
//     加 text 后字段   = [id, code]
//     sort '-created'  → invalid sort field "created"
//     sort ''          → OK     sort '-id' → OK     sort '-@rowid' → OK
//     users 上 '-created' → OK（对照组，证明是集合自身缺字段，不是 API 不支持）
//     补 AutodateField 后 '-created' → OK，且新记录 created 有值（补之前为 null）
//
// 本补丁职责（只做增量，不碰自定义字段，风险最低）：
//   ① 表不存在 → 等 v7 建（记日志、不自注销）
//   ② 表存在 → 缺 created 补 AutodateField(onCreate:true, onUpdate:false)
//               缺 updated 补 AutodateField(onCreate:true, onUpdate:true)
//   ③ 两张表都补齐 → cronRemove 自我注销
//
// 另：client_bind_helpers.js 的 find() 已加「排序失败自动降级」，补丁没跑完的那一分钟里
//     弹窗照样能出内容，不会整个 400 卡死 —— 两层防线缺一不可。

cronAdd("schema_patch_v9_bind_dates", "* * * * *", () => {
  var app = (typeof $app !== "undefined" && $app) ? $app : null;
  if (!app) { console.warn("[sp_v9] 拿不到 $app，稍后重试"); return; }

  /* 全部内联：每个回调独立 JS 上下文，顶层 function 在回调里不可见 —— pb-pitfalls ⑤ */
  var run = function (app) {
    var out = { v: 9, steps: [], errors: [], ok: false, fields: {} };
    function L(s) { out.steps.push(String(s)); try { console.log("[sp_v9] " + s); } catch (e) {} }
    function E(s) { out.errors.push(String(s)); try { console.log("[sp_v9] ERR " + s); } catch (e) {} }

    var COLS = ["client_bind_codes", "client_bindings"];

    function getCol(n) {
      try { var c = app.findCollectionByNameOrId(n); return (c && c.id) ? c : null; }
      catch (e) { return null; }   /* 查不到是 throw，不是返回 null —— pb-pitfalls ⑰ */
    }
    function namesOf(c) {
      var arr = [];
      try { for (var i = 0; i < c.fields.length; i++) { try { arr.push(String(c.fields[i].name)); } catch (e) {} } } catch (e) {}
      return arr;
    }
    function typeOf(c, n) {
      try { var f = c.fields.getByName(n); return f ? String(f.type) : ""; }
      catch (e) { return ""; }
    }

    var ok = true;
    for (var i = 0; i < COLS.length; i++) {
      var nm = COLS[i];
      var c = getCol(nm);
      if (!c) { ok = false; E(nm + " 集合尚不存在（等 schema_patch_v7 建表），本轮不改"); continue; }

      var names = namesOf(c);
      L(nm + " 补建前字段：" + names.join(","));

      /* created：只在新建时写，更新不动 */
      if (names.indexOf("created") < 0) {
        try {
          c.fields.add(new AutodateField({ name: "created", onCreate: true, onUpdate: false }));
          app.save(c);
          L(nm + ".created 已补建（autodate, onCreate）");
        } catch (e1) {
          E(nm + ".created 补建失败：" + ((e1 && e1.message) || String(e1)));
        }
      }

      /* 每次都重新取，避免持有过期引用 */
      c = getCol(nm);
      if (!c) { ok = false; E(nm + " 补 created 后复查取不到集合"); continue; }

      if (namesOf(c).indexOf("updated") < 0) {
        try {
          c.fields.add(new AutodateField({ name: "updated", onCreate: true, onUpdate: true }));
          app.save(c);
          L(nm + ".updated 已补建（autodate, onCreate+onUpdate）");
        } catch (e2) {
          E(nm + ".updated 补建失败：" + ((e2 && e2.message) || String(e2)));
        }
      }

      /* 最终复查：字段名 + 类型都要对 */
      c = getCol(nm);
      if (!c) { ok = false; E(nm + " 最终复查取不到集合"); continue; }
      var fin = namesOf(c);
      out.fields[nm] = fin;
      var tc = typeOf(c, "created");
      var tu = typeOf(c, "updated");
      if (tc !== "autodate") { ok = false; E(nm + ".created 复查：类型 " + (tc || "缺失") + " ≠ autodate"); }
      if (tu !== "autodate") { ok = false; E(nm + ".updated 复查：类型 " + (tu || "缺失") + " ≠ autodate"); }
      L(nm + " 最终字段：" + fin.join(","));
    }

    out.ok = ok && out.errors.length === 0;
    if (out.ok) L("两张表 created/updated 均已就位，cron 自我注销");
    else L("尚未就位，1 分钟后重试（errors=" + out.errors.length + "）");
    return out;
  };

  var out = null;
  try { out = run(app); }
  catch (err) { console.warn("[sp_v9] 例程异常（下轮重试）：" + ((err && err.message) || String(err))); return; }
  if (out && out.ok) {
    try { cronRemove("schema_patch_v9_bind_dates"); console.log("[sp_v9] 已自我注销"); }
    catch (e2) { console.warn("[sp_v9] cronRemove 失败（忽略）：" + ((e2 && e2.message) || String(e2))); }
  }
});
