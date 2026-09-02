// 【schema_patch_v6】业主绑定装修公司：自建 client_bind_codes / client_bindings 两张表。
//
// 取代 v5（4447 → 5948 → 10155 三版均未建成，线上每分钟刷建表失败日志）。
// 本版策略：**不再猜**，把 JSVM 的真实能力面探测出来，并开一个诊断路由供远程取证。
//
// 1) GET /api/_diag/v6?k=<DIAG_KEY> —— 现场跑一遍完整流程并返回 JSON 报告：
//      · env：Collection / TextField / RelationField / JSONField 等构造器是否可用
//      · cols：organizations / users / org_data / 两张目标表 的存在性与字段清单
//      · steps / errors：每一步的成功与失败原因
//    这样不用再让用户贴 journalctl，curl 一次就能定位。
//
// 2) cron 每分钟跑同一套例程，成功后 cronRemove 自注销（沿用 v3 已验证的套路）。
//
// ⚠️ 与 v5 的关键差别：建表分两步（先建无字段空壳 → 再逐个加字段）。
//    这样即使「字段构造器不可用」，也能区分出到底卡在「建不出集合」还是「加不上字段」，
//    而且一次 new Collection 不带 fields/indexes 是最不可能失败的最小形态。
//
// ⚠️ 安全：诊断路由会写 schema，故用随机 key 保护；本文件为临时补丁，
//    两表建成后请连同本文件一起从 pb_hooks 移除（并删掉 /api/_diag/v6 路由）。
//
// PB JSVM 注意：
//   · findCollectionByNameOrId 查不到会 throw（不是返回 null）—— pb-pitfalls ⑰
//   · 每个回调独立上下文 → 例程在各回调内内联，无顶层函数声明 —— pb-pitfalls ⑤

routerAdd("GET", "/api/_diag/v6", (e) => {
  var key = "";
  try { key = String(e.request.url.query().get("k") || ""); } catch (e) {}
  if (key !== "hajdiag2026") return e.json(403, { error: "forbidden" });
  var app = (typeof $app !== "undefined" && $app) ? $app : null;
  if (!app) return e.json(500, { error: "no $app" });
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
  catch (err) { out = { fatal: ((err && err.message) || String(err)) }; }
  return e.json(200, out);
});

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
