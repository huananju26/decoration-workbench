/* perm_sections_helper.js —— memberships.sections（版块级权限）的读写入口
   （普通 .js，不是 .pb.js：只被 require，不作为钩子加载）

   由来（#452）：线上「编辑权限」弹窗里**所有岗位都不带预设权限**，22 个版块一个没勾。

   真因（本地 PocketBase 0.40.1 实测，见 /tmp/pbsort/zz_json.pb.js 探针）：
     **PB 的 JSONField 在 goja 里 `record.get('sections')` 返回的是「原始 JSON 字节数组」，
       不是解析好的 JS 值。** 实测记录：
         DB 存 ["home","process","acct"]
           → get() 返回 len=25 的 [91,34,104,111,109,101,...]（就是 ASCII 码流）
         DB 为空 / 存 null
           → get() 返回 len=0 的 []（**看上去就是个空数组**）
       对照 TextField：get() 返回 ""（字符串）—— 所以降级路径反而不会出事。

     旧读取逻辑 `else if (typeof sv.length === 'number') { for(...) secs.push(String(sv[si])) }`
     正好命中字节数组分支，于是：
       · 从未设过权限的成员（占绝大多数）→ 读成 `[]` 而不是 `null`
         → 前端 `savedSections = []`（**空数组是 truthy！**）→ defaultAllowed = []
         → 弹窗里 22 个版块一个都不勾 —— 就是用户看到的「全部岗位都没预设权限」。
       · 设过权限的成员 → 读成 ["91","34","104",...] 一串 ASCII 码字符串
         → 匹配不上任何版块 key → 同样全不勾，而且再保存就会把垃圾回写进库。

   修法：
     ① 读取统一走 parseSections()：先判「是不是字节数组（元素是 number）」，
        是就 String.fromCharCode 还原成 JSON 文本再 parse；不是才当字符串数组。
        length===0 一律视为「未自定义」（返回 null），绝不能返回 []。
     ② 写入保持 `record.set('sections', jsArray)` —— 实测 PB 会正确存成 JSON 数组，
        不要改成存字符串（JSONField 存字符串会多包一层引号）。

   ⚠️ pb-pitfalls ⑤：每个路由回调的 JS 上下文独立，顶层声明互不可见 —— 所以共用例程
      必须放进 require 的模块，不能在各 api_*.pb.js 顶层写 function 后指望路由能调到。
*/

/* 把 PB 返回的任意形态还原成「版块 key 字符串数组」；返回 null = 未自定义（走角色默认） */
function parseSections(sv) {
  try {
    if (sv === null || sv === undefined) return null;

    /* ① 字符串形态：TextField 降级路径，或手工存的 JSON 文本 */
    if (typeof sv === 'string') {
      var t = String(sv).trim();
      if (!t || t === 'null') return null;
      if (t === '[]') return [];            /* 显式「全部取消」，区别于「未自定义」 */
      if (t.charAt(0) !== '[') return null;
      try {
        var p = JSON.parse(t);
        return (p && typeof p.length === 'number') ? norm(p) : null;
      } catch (e1) { return null; }
    }

    /* ② 数组形态（array-like） */
    if (typeof sv.length === 'number') {
      if (sv.length === 0) return null;                 /* 空 = 未自定义，绝不返回 [] */

      /* ②-a 字节数组：JSONField 的 get() 就是这玩意儿，元素是 ASCII 码 */
      if (typeof sv[0] === 'number') {
        var s = '';
        for (var i = 0; i < sv.length; i++) s += String.fromCharCode(sv[i]);
        s = s.trim();
        if (!s || s === 'null' || s.charAt(0) !== '[') return null;
        if (s === '[]') return [];          /* 显式「全部取消」（字节形态 [91,93]） */
        try {
          var p2 = JSON.parse(s);
          return (p2 && typeof p2.length === 'number') ? norm(p2) : null;
        } catch (e2) { return null; }
      }

      /* ②-b 真·字符串数组（PB 日后改了绑定、或手工构造） */
      return norm(sv);
    }
  } catch (e) { /* 任何异常都当「未自定义」，绝不把权限逻辑打挂 */ }
  return null;
}

/* 归一化：去空值、转字符串 */
function norm(a) {
  var o = [];
  for (var i = 0; i < a.length; i++) {
    var v = '';
    try { v = String(a[i]); } catch (e) { v = ''; }
    if (v) o.push(v);
  }
  return o;
}

/* 写入用：给 PB 的 set() 直接喂 JS 数组即可（DB 里落成真正的 JSON 数组） */
function encodeSections(arr) {
  if (!arr || typeof arr.length !== 'number') return null;
  var o = [];
  for (var i = 0; i < arr.length; i++) {
    var v = '';
    try { v = String(arr[i]); } catch (e) { v = ''; }
    if (v) o.push(v);
  }
  return o;
}

module.exports = {
  parseSections: parseSections,
  encodeSections: encodeSections
};
