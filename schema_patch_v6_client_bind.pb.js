// 【schema_patch_v6 · 清理版】业主绑定装修公司：守护 client_bind_codes / client_bindings 两张表。
//
// 沿革：v5（4447 → 5948 → 10155）三版都没能把表建出来，线上每分钟刷「建表失败」日志。
//       v6 首版靠「空壳建表 + 逐个加字段」成功建出两表，并临时开过一个诊断路由
//       GET /api/_diag/v6?k=<key> 用于远程取证。
// 本版 = v6 首版**去掉诊断路由**：诊断路由具备写 schema 能力、key 又写在公开仓库里，
//       表既已建成，该路由必须下线（pb-hygiene：公网不留可写 schema 的口子）。
//
// 保留 cron 守护：每分钟检查两张表是否存在且字段齐全——
//   · 齐全 → cronRemove 自注销（正常情况，重启后只跑一轮就不再出现）
//   · 缺失/字段不全 → 补建补字段（自愈），防止误删表后绑定功能静默失效
//
// 关键写法（踩过的坑，勿改回）：
//   ① findCollectionByNameOrId 查不到会 **throw**，不是返回 null —— pb-pitfalls ⑰
//   ② 建表分两步：先 new Collection({type:'base',fields:[],indexes:[]}) 建空壳 + markAsNew，
//      再 fields.add(new TextField/RelationField) 逐个加 —— 能把「建不出集合」与「加不上字段」分开暴露
//   ③ 每个回调独立上下文，例程必须在回调内内联，无顶层函数声明 —— pb-pitfalls ⑤
//   ④ 结论以「复查两张表是否真存在且字段齐全」为准，不依赖创建过程是否报错

cronAdd("schema_patch_v6", "* * * * *", () => {
  var app = (typeof $app !== "undefined" && $app) ? $app : null;
  if (!app) { console.warn("[sp_v6] 拿不到 $app，稍后重试"); return; }
  var fn = function (app) {
  var out = { v: 6, steps: [], errors: [], ok: false, env: {}, cols: {} };
  function L(s) { out.steps.push(String(s)); try { console.log("[sp_v6] " + s); } catch (e) {} }
  function E(s) { out.errors.push(String(s)); try { console.log("[sp_v6] ERR " + s); } catch (e) {} }
  /* typeof 对未声明标识符安全返回 "undefined"，不会抛 ReferenceError */
  out.env.Collection = (typeof Collection);
  out.env.Record = (typeof Record);
  out.env.DynamicModel = (typeof DynamicModel);
  out.env.TextField = (typeof TextField);
  out.env.RelationField = (typeof RelationField);
  out.env.JSONField = (typeof JSONField);
  out.env.NumberField = (typeof NumberField);
  out.env.BoolField = (typeof BoolField);
  out.env.AutodateField = (typeof AutodateField);
  function exists(n) {
    try { var c = app.findCollectionByNameOrId(n); return !!(c && c.id); }
    catch (e) { return false; }
  }
  function fieldsOf(n) {
    try {
      var c = app.findCollectionByNameOrId(n); if (!c) return null;
      var arr = [], f = c.fields;
      for (var k = 0; k < f.length; k++) { try { arr.push(f[k].name + ":" + f[k].type); } catch (e2) {} }
      return arr;
    } catch (e) { return null; }
  }
  ["organizations", "users", "org_data", "client_bind_codes", "client_bindings"].forEach(function (n) {
    out.cols[n] = { exists: exists(n), fields: fieldsOf(n) };
  });
  var orgColId = "", userColId = "";
  try { orgColId = String(app.findCollectionByNameOrId("organizations").id || ""); } catch (e1) {}
  try { userColId = String(app.findCollectionByNameOrId("users").id || ""); } catch (e2) {}
  out.orgColId = orgColId; out.userColId = userColId;
  if (!orgColId || !userColId) { E("拿不到 organizations/users 的 collectionId，无法建关系字段"); return out; }
  var plan = [
    { name: "client_bind_codes", fields: [
        { n: "org", kind: "relation", target: orgColId },
        { n: "code", kind: "text" } ] },
    { name: "client_bindings", fields: [
        { n: "owner", kind: "relation", target: userColId },
        { n: "org", kind: "relation", target: orgColId },
        { n: "org_name", kind: "text" } ] }
  ];
  for (var p = 0; p < plan.length; p++) {
    var P = plan[p];
    if (!exists(P.name)) {
      if (out.env.Collection !== "function") {
        E(P.name + " 无法创建：Collection 构造器不可用（typeof=" + out.env.Collection + "）");
        continue;
      }
      try {
        var c = new Collection({ type: "base", name: P.name, fields: [], indexes: [] });
        if (typeof c.markAsNew === "function") c.markAsNew();
        app.save(c);
        L(P.name + " 空壳创建成功");
      } catch (e3) {
        E(P.name + " 空壳创建失败：" + ((e3 && e3.message) || String(e3)));
        continue;
      }
    }
    if (!exists(P.name)) { E(P.name + " 创建后复查仍不存在"); continue; }
    for (var fi = 0; fi < P.fields.length; fi++) {
      var FD = P.fields[fi], c2 = null;
      try { c2 = app.findCollectionByNameOrId(P.name); } catch (e4) { c2 = null; }
      if (!c2) { E(P.name + " 重新取集合失败"); break; }
      try { if (c2.fields.getByName(FD.n)) { continue; } } catch (e5) {}
      var made = false;
      try {
        if (FD.kind === "text") { c2.fields.add(new TextField({ name: FD.n, max: 100 })); made = true; }
        else if (FD.kind === "relation") { c2.fields.add(new RelationField({ name: FD.n, collectionId: FD.target, maxSelect: 1, required: true })); made = true; }
      } catch (e6) {
        E(P.name + "." + FD.n + " 字段构造/添加失败（" + FD.kind + "）：" + ((e6 && e6.message) || String(e6)));
      }
      if (!made) { continue; }
      try { app.save(c2); L(P.name + "." + FD.n + " 字段已添加"); }
      catch (e7) { E(P.name + "." + FD.n + " 字段保存失败：" + ((e7 && e7.message) || String(e7))); }
    }
    out.cols[P.name] = { exists: exists(P.name), fields: fieldsOf(P.name) };
  }
  var a = (out.cols["client_bind_codes"] && out.cols["client_bind_codes"].fields) || [];
  var b = (out.cols["client_bindings"] && out.cols["client_bindings"].fields) || [];
  out.ok = a.length >= 2 && b.length >= 3;
  if (!out.ok) E("字段不全：codes=" + a.join(",") + " | bindings=" + b.join(","));
  else L("两张表与字段均已就位");
  return out;
};
  var out = null;
  try { out = fn(app); }
  catch (err) { console.warn("[sp_v6] 例程异常（下轮重试）：" + ((err && err.message) || String(err))); return; }
  if (out && out.ok) {
    try { cronRemove("schema_patch_v6"); console.log("[sp_v6] 两张表已就位，cron 自我注销"); }
    catch (e2) { console.warn("[sp_v6] cronRemove 失败（忽略）：" + ((e2 && e2.message) || String(e2))); }
  }
});
