// 【schema_patch_v7 · 严格体检版】业主绑定两张表：client_bind_codes / client_bindings
//
// 沿革：
//   v5（三版）都没能把表建出来，线上每分钟刷「建表失败」日志。
//   v6 首版靠「空壳建表 + 逐个加字段」把两张表建出来了（/api/collections/<name>/records
//      返回 403 = 表存在），但它的**字段齐全判定写错了**：
//        out.ok = a.length >= 2 && b.length >= 3
//      而 `collection.fields` 里本来就含 id / created / updated 三个系统字段 ——
//      哪怕三个自定义字段一个都没加成功，b.length 也 >= 3，判定照样通过、cron 照样
//      cronRemove 自我注销。结果留下「表在、字段不在」的僵尸状态：
//      任何按自定义字段的过滤（owner = 'x' / org = 'x'）都因**过滤器语法错**抛异常，
//      前端只看到「绑定表未就绪：请确认 schema_patch_v5 已执行（HTTP 400）」—— #491 真因。
//
// v7 的改进（勿改回）：
//   ① 体检按**字段名**逐个比对（fields.getByName），不再数 fields.length
//   ② 顺带校验字段**类型**（relation / text）；类型不符且表内无记录时才删除重建
//   ③ 建集合仍走「空壳 + fields.add 逐个加 + 每步 save」，与 v6 一致（已验证可行）
//   ④ RelationField 先按 required:true 试，失败降级 required:false（防历史脏数据卡住）
//   ⑤ 只有两张表「存在 + 字段齐全 + 类型正确」才 cronRemove；否则每分钟重试并打日志
//      日志里会打印两表的完整字段清单（grep sp_v7 即可取证），便于远程确认
//   ⑥ 不开任何诊断路由 —— pb-hygiene：公网不留可写 schema 的口子

cronAdd("schema_patch_v7", "* * * * *", () => {
  var app = (typeof $app !== "undefined" && $app) ? $app : null;
  if (!app) { console.warn("[sp_v7] 拿不到 $app，稍后重试"); return; }

  /* 全部例程内联：每个回调独立 JS 上下文，顶层 function 在回调里不可见 —— pb-pitfalls ⑤ */
  var run = function (app) {
    var out = { v: 7, steps: [], errors: [], ok: false, fields: {} };
    function L(s) { out.steps.push(String(s)); try { console.log("[sp_v7] " + s); } catch (e) {} }
    function E(s) { out.errors.push(String(s)); try { console.log("[sp_v7] ERR " + s); } catch (e) {} }

    var plan = [
      { name: "client_bind_codes", fields: [
          { n: "org",  kind: "relation", target: "organizations" },
          { n: "code", kind: "text" } ] },
      { name: "client_bindings", fields: [
          { n: "owner",    kind: "relation", target: "users" },
          { n: "org",      kind: "relation", target: "organizations" },
          { n: "org_name", kind: "text" } ] }
    ];

    /* 目标集合 id（关系字段要用） */
    var targetId = {};
    ["organizations", "users"].forEach(function (n) {
      try { targetId[n] = String(app.findCollectionByNameOrId(n).id || ""); }
      catch (e) { targetId[n] = ""; }
    });
    if (!targetId.organizations || !targetId.users) {
      E("拿不到 organizations/users 的 collectionId，无法建关系字段");
      return out;
    }

    function getCol(n) {
      try { var c = app.findCollectionByNameOrId(n); return (c && c.id) ? c : null; }
      catch (e) { return null; }   /* 查不到是 throw，不是返回 null —— pb-pitfalls ⑰ */
    }
    function namesOf(c) {
      var arr = [];
      try {
        for (var i = 0; i < c.fields.length; i++) { try { arr.push(String(c.fields[i].name)); } catch (e) {} }
      } catch (e) {}
      return arr;
    }
    function typeOf(c, n) {
      try { var f = c.fields.getByName(n); return f ? String(f.type) : ""; }
      catch (e) { return ""; }
    }
    function countOf(n) {
      try {
        var rs = app.findRecordsByFilter(n, "id != ''", "", 1, 0);
        return (rs && rs.length != null) ? rs.length : 0;
      } catch (e) { return -1; }   /* 查不动（多半是字段还没建好）→ 返回 -1，不据此判空 */
    }

    for (var p = 0; p < plan.length; p++) {
      var P = plan[p];
      var col = getCol(P.name);
      if (!col) {
        /* ① 空壳建集合 */
        try {
          var nc = new Collection({ type: "base", name: P.name, fields: [], indexes: [] });
          if (typeof nc.markAsNew === "function") nc.markAsNew();
          app.save(nc);
          L(P.name + " 空壳创建成功");
        } catch (e1) {
          E(P.name + " 空壳创建失败：" + ((e1 && e1.message) || String(e1)));
          continue;
        }
        col = getCol(P.name);
        if (!col) { E(P.name + " 创建后复查仍不存在"); continue; }
      }

      /* ② 逐个字段：按名比对 + 校验类型 */
      for (var fi = 0; fi < P.fields.length; fi++) {
        var FD = P.fields[fi];
        var cur = getCol(P.name);            /* 每次重新取，避免持有过期引用 */
        if (!cur) { E(P.name + " 重新取集合失败"); break; }
        var t = typeOf(cur, FD.n);

        if (t && t !== FD.kind) {
          /* 类型不符：只有确认表内没有记录时才敢删字段重建（避免丢绑定关系） */
          var cnt = countOf(P.name);
          if (cnt === 0) {
            try {
              cur.fields.remove(FD.n);
              app.save(cur);
              L(P.name + "." + FD.n + " 类型不符（" + t + "≠" + FD.kind + "）且表为空 → 已删除待重建");
              t = "";
            } catch (eRm) {
              E(P.name + "." + FD.n + " 删除失败：" + ((eRm && eRm.message) || String(eRm)));
            }
          } else {
            E(P.name + "." + FD.n + " 类型不符（" + t + "≠" + FD.kind + "），表内有 " + cnt + " 条记录，拒绝自动重建以免丢数据");
          }
        }
        if (t) { continue; }                 /* 已存在且类型正确 */

        /* ③ 加字段 */
        var made = false;
        try {
          if (FD.kind === "text") {
            cur.fields.add(new TextField({ name: FD.n, max: 200 }));
            made = true;
          } else if (FD.kind === "relation") {
            try {
              cur.fields.add(new RelationField({ name: FD.n, collectionId: targetId[FD.target], maxSelect: 1, required: true }));
              made = true;
            } catch (eReq) {
              /* required:true 建不出来就降级不强制，总好过字段一直缺席 */
              var cur2 = getCol(P.name);
              if (cur2) {
                cur2.fields.add(new RelationField({ name: FD.n, collectionId: targetId[FD.target], maxSelect: 1, required: false }));
                cur = cur2;
                made = true;
                L(P.name + "." + FD.n + " required:true 失败，已降级 required:false");
              }
            }
          } else {
            E(P.name + "." + FD.n + " 未知字段类型：" + FD.kind);
          }
        } catch (e6) {
          E(P.name + "." + FD.n + " 字段构造/添加失败（" + FD.kind + "）：" + ((e6 && e6.message) || String(e6)));
        }
        if (!made) { continue; }
        try { app.save(cur); L(P.name + "." + FD.n + " 字段已添加（" + FD.kind + "）"); }
        catch (e7) { E(P.name + "." + FD.n + " 字段保存失败：" + ((e7 && e7.message) || String(e7))); }
      }

      var fin = getCol(P.name);
      out.fields[P.name] = fin ? namesOf(fin) : [];
      L(P.name + " 当前字段：" + (out.fields[P.name] || []).join(","));
    }

    /* ④ 只有「两表都存在且字段齐全」才算成功，才允许自我注销 */
    var ok = true;
    for (var q = 0; q < plan.length; q++) {
      var PP = plan[q];
      var cq = getCol(PP.name);
      if (!cq) { ok = false; E(PP.name + " 最终复查：集合不存在"); continue; }
      for (var qi = 0; qi < PP.fields.length; qi++) {
        var tq = typeOf(cq, PP.fields[qi].n);
        if (tq !== PP.fields[qi].kind) { ok = false; E(PP.name + "." + PP.fields[qi].n + " 最终复查：类型 " + (tq || "缺失") + " ≠ " + PP.fields[qi].kind); }
      }
    }
    out.ok = ok && out.errors.length === 0;
    if (out.ok) L("两张表与字段均已就位，cron 自我注销");
    else L("尚未就位，1 分钟后重试（errors=" + out.errors.length + "）");
    return out;
  };

  var out = null;
  try { out = run(app); }
  catch (err) { console.warn("[sp_v7] 例程异常（下轮重试）：" + ((err && err.message) || String(err))); return; }
  if (out && out.ok) {
    try { cronRemove("schema_patch_v7"); console.log("[sp_v7] 已自我注销"); }
    catch (e2) { console.warn("[sp_v7] cronRemove 失败（忽略）：" + ((e2 && e2.message) || String(e2))); }
  }
});
