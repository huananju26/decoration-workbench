/* client_bind_helpers.js —— /api/client/* 五个绑定路由共用的「绑定表体检 + 查询」封装
   （普通 .js，不是 .pb.js：只被 require，不作为钩子加载）

   由来（#491）：线上绑定弹窗一直报「绑定表未就绪：请确认 schema_patch_v5 已执行（HTTP 400）」。
   旧写法有三个毛病，一起在这里根治：
     ① 集合存在 ≠ 字段存在。schema_patch_v6 用 `fields.length >= 3` 判定字段齐全，
        但 id/created/updated 三个系统字段本身就够 3 个 —— 字段一个没加成功也会判定通过
        并 cronRemove 自我注销，留下「表在、字段不在」的僵尸状态，之后任何按字段的过滤
        （owner = 'x' / org = 'x'）都会因过滤器语法错而抛异常。
     ② 旧代码把「表缺失 / 字段缺失 / 过滤语法错 / 权限异常」一律 catch 成同一句
        「绑定表未就绪：请确认 schema_patch_v5 已执行」，既过期（v5 早已被 v6 取代）
        又把真实原因吞掉，前端只看到 400，永远查不出是哪一类。
     ③ bindcode 路由按 `org_id` 过滤，而表里字段名叫 `org` —— 百分之百过滤失败。

   用法（每个路由回调内）：
     const H = require(`${__hooks}/client_bind_helpers.js`);
     const r = H.find($app, H.BINDINGS, "owner = '" + auth.id + "'", '-created', 100);
     if (!r.ok) throw new BadRequestError(H.errText(r, '读取绑定列表'));
     // r.rows 可直接 .length / [i] / .get('x')

   ⚠️ pb-pitfalls ⑤：每个路由回调的 JS 上下文独立，顶层声明互不可见 —— 所以共用例程
      必须放进 require 的模块，不能在 api_acct.pb.js 顶层写 function 后指望路由能调到。
*/

var BIND_CODES = 'client_bind_codes';
var BINDINGS = 'client_bindings';

/* 两张表各自必须具备的自定义字段（缺一个就算不健康） */
var NEED = {};
NEED[BIND_CODES] = ['org', 'code'];
NEED[BINDINGS] = ['owner', 'org', 'org_name'];

function fieldNames(app, col) {
  var c = null;
  try { c = app.findCollectionByNameOrId(col); } catch (e) { return null; }  // 不存在会 throw，不是返回 null
  if (!c) return null;
  var out = [];
  var f = null;
  try { f = c.fields; } catch (eF) { return out; }
  var n = 0;
  try { n = f.length; } catch (eN) { n = 0; }
  for (var i = 0; i < n; i++) {
    try { out.push(String(f[i].name)); } catch (e2) { /* 单个字段取不到名，跳过 */ }
  }
  return out;
}

function check(app) {
  var res = { ok: true, tableMissing: [], fieldMissing: [], fields: {} };
  var cols = [BIND_CODES, BINDINGS];
  for (var i = 0; i < cols.length; i++) {
    var col = cols[i];
    var fs = fieldNames(app, col);
    if (fs === null) { res.ok = false; res.tableMissing.push(col); continue; }
    res.fields[col] = fs;
    var need = NEED[col] || [];
    for (var k = 0; k < need.length; k++) {
      if (fs.indexOf(need[k]) < 0) {
        res.ok = false;
        res.fieldMissing.push(col + '.' + need[k]);
      }
    }
  }
  return res;
}

/* 统一查询入口：永不抛异常，一律以 {ok, ...} 回执，由路由决定怎么报给用户 */
function find(app, col, filter, sort, limit) {
  var ck = check(app);
  if (ck.tableMissing.length > 0) {
    return { ok: false, kind: 'no-table', msg: ck.tableMissing.join('、') };
  }
  if (ck.fieldMissing.length > 0) {
    return { ok: false, kind: 'no-field', msg: ck.fieldMissing.join('、') };
  }
  /* 排序降级链：'-created' → '-id' → ''（不排序）
     #451：JSVM 空壳建表（new Collection({fields:[]})）**不会自动补 created/updated**
     —— 实测建出来的集合只有 id，于是任何按 -created 的排序都抛
        `invalid sort field "created"`，把整个绑定弹窗打成 400（详见 pb-pitfalls ㉖）。
     根因由 schema_patch_v9_bind_dates 补字段解决；这里加降级是为了让**补丁跑完前那一分钟**
     弹窗也能出内容，而不是整块红字报错。
     · 只有「排序类」错误才值得换排序重试；过滤语法错 / 权限异常换排序也没用，直接回。 */
  var want = sort || '-created';
  var tries = [want, '-id', ''];
  if (want === '-created') tries = ['-created', '-id', ''];
  var last = '';
  for (var i = 0; i < tries.length; i++) {
    try {
      var rows = app.findRecordsByFilter(col, filter, tries[i], limit || 100, 0);
      return { ok: true, rows: rows || [], sort: tries[i] };
    } catch (err) {
      last = String((err && err.message) ? err.message : err);
      if (last.indexOf('sort') < 0) {
        return { ok: false, kind: 'query', msg: last };   /* 非排序错误，换排序没意义 */
      }
    }
  }
  return { ok: false, kind: 'query', msg: last };
}

/* 把 find 的回执翻成能直接甩给用户看的中文 */
function errText(r, what) {
  if (!r) return what + '失败：未知原因';
  if (r.kind === 'no-table') {
    return what + '失败：服务端绑定表尚未建立（缺 ' + r.msg + '）。schema_patch_v7 每分钟自愈一次，请约 1 分钟后重试';
  }
  if (r.kind === 'no-field') {
    return what + '失败：绑定表字段缺失（' + r.msg + '）。服务端自愈补丁正在修复，请约 1 分钟后重试';
  }
  return what + '失败：' + r.msg;
}

module.exports = {
  BIND_CODES: BIND_CODES,
  BINDINGS: BINDINGS,
  fieldNames: fieldNames,
  check: check,
  find: find,
  errText: errText
};
