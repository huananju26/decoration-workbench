/// <reference path="../pb_data/types.d.ts" />
//
// ============================================================================
// 团队管理增强路由（S2）：邀请取消/删除 · 退出/移出团队 · 多团队列表/切换 · 改角色
// 部署位置：/opt/pocketbase/pb_hooks/api_team.pb.js
// ============================================================================
//
// ⚠️ 写法铁律（见 .workbuddy/memory/pb-pitfalls.md ⑤，别想着抽公共函数）：
//    JSVM 里**每个路由回调都是独立 JS 上下文**，写在回调外的 function/const 在回调里
//    统统 undefined（实测 ReferenceError）。所以下面每个路由都完全自包含、逐字重复
//    取 auth / 查 membership 的代码。看着啰嗦，但这是唯一能跑的写法。
//
// 【数据模型约定】
//   memberships：一行 = 一个 (user, org) 关系，status ∈ active|left|removed。
//                退出/移出**不删行**（留痕 + 复用），重新加入把 status 翻回 active。
//   users.org_id：语义降级为「当前激活团队」缓存 —— 既有 15+ 个租户隔离路由
//                （/api/data/*、/api/sync/*、/api/cleanup/* …）全部零改动继续用它。
//   users.role  ：语义降级为「当前激活团队里的角色」缓存。
//   ⇒ 判定权限一律以 **memberships.role** 为准，users.role 只作回退。
//
// 【已拍板决策】
//   决策 2：「取消邀请」(revoked=true，链接立即失效、记录留痕)
//           与「删除邀请」(真删记录) 是两件事，两个接口。
//   决策 3：唯一管理员**禁止**退出/被移出，必须先转让管理员（故有 /api/org/set-role）。
// ============================================================================


// ---------------------------------------------------------------------------
// 1) GET /api/org/invitations —— 当前团队的邀请列表（管理员）
//    状态派生：accepted > revoked > expired > pending
// ---------------------------------------------------------------------------
routerAdd('GET', '/api/org/invitations', (e) => {
  let auth = e.auth;
  if (!auth || !auth.id) {
    let hdr = '';
    try { hdr = e.request.header.get('Authorization') || ''; } catch (eH) { hdr = ''; }
    const tk = hdr.indexOf(' ') > -1 ? hdr.split(' ')[1] : hdr;
    if (tk) { try { auth = $app.findAuthRecordByToken(tk); } catch (err) { auth = null; } }
  }
  if (!auth || !auth.id) throw new ForbiddenError('未登录');
  const org = String(auth.get('org_id') || '');
  if (!org) throw new BadRequestError('你还没有加入任何团队');

  // 角色以当前团队的 membership 为准
  let myRole = String(auth.get('role') || '');
  try {
    const m = $app.findFirstRecordByFilter('memberships',
      "user_id = '" + auth.id + "' && org_id = '" + org + "' && status = 'active'");
    if (m) myRole = String(m.get('role') || myRole);
  } catch (eR) {}
  if (myRole !== 'admin') throw new ForbiddenError('只有管理员可以查看邀请');

  let rows = [];
  try {
    rows = $app.findRecordsByFilter('invitations', "org_id = '" + org + "'", '-created', 200, 0);
  } catch (eL) { rows = []; }

  const now = new Date();
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const expRaw = String(r.get('expires') || '').replace(' ', 'T');
    const expired = expRaw ? (new Date(expRaw) < now) : false;
    let st = 'pending';
    if (r.get('accepted')) st = 'accepted';
    else if (r.get('revoked')) st = 'revoked';
    else if (expired) st = 'expired';
    out.push({
      id: String(r.id),
      email: String(r.get('email') || ''),
      role: String(r.get('role') || ''),
      token: String(r.get('token') || ''),
      expires: expRaw,
      accepted: !!r.get('accepted'),
      revoked: !!r.get('revoked'),
      revoked_at: String(r.get('revoked_at') || ''),
      created: String(r.get('created') || ''),
      status: st
    });
  }
  return e.json(200, { ok: true, invitations: out });
});


// ---------------------------------------------------------------------------
// 2) POST /api/org/invite/revoke —— 取消邀请（链接立即失效，记录保留）
//    body: { id }  或  { token }
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/org/invite/revoke', (e) => {
  let auth = e.auth;
  if (!auth || !auth.id) {
    let hdr = '';
    try { hdr = e.request.header.get('Authorization') || ''; } catch (eH) { hdr = ''; }
    const tk = hdr.indexOf(' ') > -1 ? hdr.split(' ')[1] : hdr;
    if (tk) { try { auth = $app.findAuthRecordByToken(tk); } catch (err) { auth = null; } }
  }
  if (!auth || !auth.id) throw new ForbiddenError('未登录');
  const org = String(auth.get('org_id') || '');
  if (!org) throw new BadRequestError('你还没有加入任何团队');

  let myRole = String(auth.get('role') || '');
  try {
    const m = $app.findFirstRecordByFilter('memberships',
      "user_id = '" + auth.id + "' && org_id = '" + org + "' && status = 'active'");
    if (m) myRole = String(m.get('role') || myRole);
  } catch (eR) {}
  if (myRole !== 'admin') throw new ForbiddenError('只有管理员可以取消邀请');

  const data = new DynamicModel({ id: '', token: '' });
  e.bindBody(data);
  const invId = String(data.id || '');
  const invTok = String(data.token || '');
  if (!invId && !invTok) throw new BadRequestError('缺少邀请标识');

  let inv = null;
  try {
    if (invId) inv = $app.findRecordById('invitations', invId);
    else inv = $app.findFirstRecordByFilter('invitations', "token = '" + invTok + "'");
  } catch (eF) { inv = null; }
  if (!inv) throw new NotFoundError('邀请不存在');
  // 跨租户防越权：只能动自己团队的邀请
  if (String(inv.get('org_id') || '') !== org) throw new NotFoundError('邀请不存在');
  if (inv.get('accepted')) throw new BadRequestError('该邀请已被接受，请到成员列表「移出团队」');
  if (inv.get('revoked')) return e.json(200, { ok: true, already: true, id: String(inv.id) });

  inv.set('revoked', true);
  inv.set('revoked_at', new Date().toISOString());
  $app.save(inv);
  return e.json(200, { ok: true, id: String(inv.id), revoked: true });
});


// ---------------------------------------------------------------------------
// 3) POST /api/org/invite/delete —— 删除邀请记录（真删）
//    body: { id }
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/org/invite/delete', (e) => {
  let auth = e.auth;
  if (!auth || !auth.id) {
    let hdr = '';
    try { hdr = e.request.header.get('Authorization') || ''; } catch (eH) { hdr = ''; }
    const tk = hdr.indexOf(' ') > -1 ? hdr.split(' ')[1] : hdr;
    if (tk) { try { auth = $app.findAuthRecordByToken(tk); } catch (err) { auth = null; } }
  }
  if (!auth || !auth.id) throw new ForbiddenError('未登录');
  const org = String(auth.get('org_id') || '');
  if (!org) throw new BadRequestError('你还没有加入任何团队');

  let myRole = String(auth.get('role') || '');
  try {
    const m = $app.findFirstRecordByFilter('memberships',
      "user_id = '" + auth.id + "' && org_id = '" + org + "' && status = 'active'");
    if (m) myRole = String(m.get('role') || myRole);
  } catch (eR) {}
  if (myRole !== 'admin') throw new ForbiddenError('只有管理员可以删除邀请');

  const data = new DynamicModel({ id: '' });
  e.bindBody(data);
  const invId = String(data.id || '');
  if (!invId) throw new BadRequestError('缺少邀请 id');

  let inv = null;
  try { inv = $app.findRecordById('invitations', invId); } catch (eF) { inv = null; }
  if (!inv) return e.json(200, { ok: true, already: true });
  if (String(inv.get('org_id') || '') !== org) throw new NotFoundError('邀请不存在');

  $app.delete(inv);
  return e.json(200, { ok: true, deleted: invId });
});


// ---------------------------------------------------------------------------
// 4) GET /api/org/members —— 当前团队真实成员列表（替代前端 xzgz_team_cache 假数据）
//    任何成员都能看（成员名单不是敏感信息），但只有 admin 能在前端看到操作按钮。
// ---------------------------------------------------------------------------
routerAdd('GET', '/api/org/members', (e) => {
  let auth = e.auth;
  if (!auth || !auth.id) {
    let hdr = '';
    try { hdr = e.request.header.get('Authorization') || ''; } catch (eH) { hdr = ''; }
    const tk = hdr.indexOf(' ') > -1 ? hdr.split(' ')[1] : hdr;
    if (tk) { try { auth = $app.findAuthRecordByToken(tk); } catch (err) { auth = null; } }
  }
  if (!auth || !auth.id) throw new ForbiddenError('未登录');
  const org = String(auth.get('org_id') || '');
  if (!org) throw new BadRequestError('你还没有加入任何团队');

  let myRole = String(auth.get('role') || '');
  try {
    const mm = $app.findFirstRecordByFilter('memberships',
      "user_id = '" + auth.id + "' && org_id = '" + org + "' && status = 'active'");
    if (mm) myRole = String(mm.get('role') || myRole);
  } catch (eR) {}

  let rows = [];
  try {
    rows = $app.findRecordsByFilter('memberships',
      "org_id = '" + org + "' && status = 'active'", 'created', 500, 0);
  } catch (eL) { rows = []; }

  // 兜底：memberships 还没回填（补丁未跑）时，至少把自己列出来，页面不至于空白
  if (!rows.length) {
    return e.json(200, {
      ok: true,
      degraded: true,
      my_role: myRole,
      members: [{
        id: String(auth.id),
        user_id: String(auth.id),
        email: String(auth.get('email') || ''),
        display_name: String(auth.get('display_name') || ''),
        role: myRole,
        status: 'active',
        joined_at: String(auth.get('created') || ''),
        is_me: true,
        sections: null
      }]
    });
  }

  const out = [];
  let adminCount = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const uid = String(r.get('user_id') || '');
    let email = '';
    let dname = '';
    let ustatus = '';
    try {
      const u = $app.findRecordById('users', uid);
      email = String(u.get('email') || '');
      dname = String(u.get('display_name') || '');
      ustatus = String(u.get('status') || '');
    } catch (eU) {}
    const role = String(r.get('role') || '');
    if (role === 'admin') adminCount++;
    /* #447/#452 版块级权限（memberships.sections）
       🩸 #452 血案：**PB 的 JSONField 在 goja 里 get() 返回的是「原始 JSON 字节数组」**，
          不是解析好的 JS 值（本地 0.40.1 实测：DB 存 ["home","process"]，
          get() 拿到 [91,34,104,111,109,101,...] 一串 ASCII 码；字段为空时拿到 len=0 的 []）。
          旧逻辑 `typeof sv.length === 'number'` 正好命中字节数组分支，于是
          「从没设过权限的成员」被读成 `[]` 而不是 null → 前端空数组是 truthy
          → 22 个版块一个都不勾 —— 用户看到的「全部岗位都没预设权限」。
          解析统一交给 perm_sections_helper.js（能识别字节数组并还原），
          这里只保留「模块拿不到就静默降级为未自定义」的兜底。
       null = 该成员没有自定义，走角色默认矩阵。 */
    let secs = null;
    try {
      let PS = null;
      try { PS = require(`${__hooks}/perm_sections_helper.js`); } catch (eReq) { PS = null; }
      if (PS && typeof PS.parseSections === 'function') {
        secs = PS.parseSections(r.get('sections'));
      } else {
        /* 模块缺失时的极简兜底：只认字符串，其余一律当未自定义（宁可走角色默认，也不要错的 []） */
        const sv = r.get('sections');
        if (typeof sv === 'string' && sv.trim() && sv.trim().charAt(0) === '[') {
          try { const pv = JSON.parse(sv.trim()); secs = (pv && typeof pv.length === 'number') ? pv : null; }
          catch (eP) { secs = null; }
        }
      }
    } catch (eS) { secs = null; }
    out.push({
      id: String(r.id),
      user_id: uid,
      email: email,
      display_name: dname,
      role: role,
      status: String(r.get('status') || ''),
      user_status: ustatus,
      joined_at: String(r.get('joined_at') || r.get('created') || ''),
      is_me: uid === String(auth.id),
      sections: secs
    });
  }
  return e.json(200, { ok: true, my_role: myRole, admin_count: adminCount, members: out });
});


// ---------------------------------------------------------------------------
// 4.5) POST /api/org/set-sections —— 企业管理员：设置某成员的版块级权限（#447）
//      body: { user_id, sections: JSON 字符串数组 }
//        · 传具体数组 = 该成员只能访问这些版块（22 版块 key 的子集）
//        · 传空数组   = 全部取消（只剩管理员恒权以外的入口）
//        · 传 null    = 清除自定义，恢复角色默认矩阵
//      落点：memberships.sections（schema_patch_v8 补的字段），随成员关系走，
//            谁登录都读到同一份 —— 以前只写管理员本机 localStorage，本人那侧毫无变化。
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/org/set-sections', (e) => {
  let auth = e.auth;
  if (!auth || !auth.id) {
    let hdr = '';
    try { hdr = e.request.header.get('Authorization') || ''; } catch (eH) { hdr = ''; }
    const tk = hdr.indexOf(' ') > -1 ? hdr.split(' ')[1] : hdr;
    if (tk) { try { auth = $app.findAuthRecordByToken(tk); } catch (err) { auth = null; } }
  }
  if (!auth || !auth.id) throw new ForbiddenError('未登录');
  const org = String(auth.get('org_id') || '');
  if (!org) throw new BadRequestError('你还没有加入任何团队');

  /* 管理员闸门：优先 memberships.role，回退 users.role */
  let myRole = String(auth.get('role') || '');
  try {
    const m = $app.findFirstRecordByFilter('memberships',
      "user_id = '" + auth.id + "' && org_id = '" + org + "' && status = 'active'");
    if (m) myRole = String(m.get('role') || myRole);
  } catch (eR) {}
  if (myRole !== 'admin') throw new ForbiddenError('只有企业管理员可以设置成员权限');

  /* sections 走 JSON 字符串：DynamicModel 绑数组没有先例（本仓库其它路由都不敢用），
     字符串 + JSON.parse 是确定性的，不存在「绑成空数组还自以为成功」的静默失败。 */
  const data = new DynamicModel({ user_id: '', sections: '' });
  e.bindBody(data);
  const target = String(data.user_id || '');
  if (!target) throw new BadRequestError('缺少成员 user_id');

  let arr = null;                                  /* null = 清除自定义 */
  const raw = String(data.sections || '').trim();
  if (raw && raw !== 'null') {
    try {
      const pv = JSON.parse(raw);
      if (pv && typeof pv.length === 'number') {
        arr = [];
        for (let i = 0; i < pv.length; i++) arr.push(String(pv[i]));
      } else { throw new Error('不是数组'); }
    } catch (eP) {
      throw new BadRequestError('sections 格式不正确：应为 JSON 数组字符串');
    }
  }

  let mem = null;
  try {
    mem = $app.findFirstRecordByFilter('memberships',
      "user_id = '" + target + "' && org_id = '" + org + "' && status = 'active'");
  } catch (eF) { mem = null; }
  if (!mem) throw new NotFoundError('该成员不在本公司（或成员关系未激活）');

  /* 🩸 PB 的 record.set() 对**不存在**的字段是静默忽略 —— 不先确认字段在，
       就会「看起来保存成功、实际什么都没写」，下一次排查又得花半天。 */
  let hasField = false;
  try {
    const mc = $app.findCollectionByNameOrId('memberships');
    hasField = !!(mc && mc.fields.getByName('sections'));
  } catch (eC) { hasField = false; }
  if (!hasField) {
    throw new BadRequestError('服务端 memberships.sections 字段尚未就绪（schema_patch_v8 每分钟自愈一次），请约 1 分钟后重试');
  }

  let PS2 = null;
  try { PS2 = require(`${__hooks}/perm_sections_helper.js`); } catch (eReq2) { PS2 = null; }
  try {
    if (arr === null) mem.set('sections', null);
    else mem.set('sections', (PS2 && typeof PS2.encodeSections === 'function') ? PS2.encodeSections(arr) : arr);
    $app.save(mem);
  } catch (err) {
    throw new BadRequestError('权限保存失败：' + String(err && err.message ? err.message : err));
  }
  return e.json(200, { ok: true, user_id: target, sections: arr });
});


// ---------------------------------------------------------------------------
// 5) POST /api/org/leave —— 本人退出团队
//    body: { org_id? }  省略则退出当前激活团队
//    闸门（决策 3）：唯一管理员禁止退出，必须先转让管理员
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/org/leave', (e) => {
  let auth = e.auth;
  if (!auth || !auth.id) {
    let hdr = '';
    try { hdr = e.request.header.get('Authorization') || ''; } catch (eH) { hdr = ''; }
    const tk = hdr.indexOf(' ') > -1 ? hdr.split(' ')[1] : hdr;
    if (tk) { try { auth = $app.findAuthRecordByToken(tk); } catch (err) { auth = null; } }
  }
  if (!auth || !auth.id) throw new ForbiddenError('未登录');

  const data = new DynamicModel({ org_id: '' });
  e.bindBody(data);
  const target = String(data.org_id || auth.get('org_id') || '');
  if (!target) throw new BadRequestError('你还没有加入任何团队');

  let mine = null;
  try {
    mine = $app.findFirstRecordByFilter('memberships',
      "user_id = '" + auth.id + "' && org_id = '" + target + "' && status = 'active'");
  } catch (eM) { mine = null; }
  if (!mine) throw new BadRequestError('你不在该团队中');

  // 唯一管理员不许退出（否则团队永久无人可管）
  if (String(mine.get('role') || '') === 'admin') {
    let admins = [];
    try {
      admins = $app.findRecordsByFilter('memberships',
        "org_id = '" + target + "' && status = 'active' && role = 'admin'", '', 50, 0);
    } catch (eA) { admins = []; }
    if (admins.length <= 1) {
      throw new BadRequestError('你是该团队唯一的管理员，请先在成员列表把管理员转让给他人，再退出团队');
    }
  }

  mine.set('status', 'left');
  $app.save(mine);

  // 若退的正是当前激活团队 → 自动切到其它 active 团队；没有则清空（回到闸门页）
  let nextOrg = '';
  let nextRole = '';
  if (String(auth.get('org_id') || '') === target) {
    let others = [];
    try {
      others = $app.findRecordsByFilter('memberships',
        "user_id = '" + auth.id + "' && status = 'active'", '-created', 20, 0);
    } catch (eO) { others = []; }
    if (others.length) {
      nextOrg = String(others[0].get('org_id') || '');
      nextRole = String(others[0].get('role') || 'reader');
    }
    auth.set('org_id', nextOrg);
    auth.set('role', nextRole);
    $app.save(auth);
  }

  let nextName = '';
  if (nextOrg) {
    try { nextName = String($app.findRecordById('organizations', nextOrg).get('name') || ''); } catch (eN) {}
  }
  return e.json(200, { ok: true, left: target, next_org_id: nextOrg, next_org_name: nextName, next_role: nextRole });
});


// ---------------------------------------------------------------------------
// 6) POST /api/org/remove —— 管理员把成员移出团队
//    body: { user_id }
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/org/remove', (e) => {
  let auth = e.auth;
  if (!auth || !auth.id) {
    let hdr = '';
    try { hdr = e.request.header.get('Authorization') || ''; } catch (eH) { hdr = ''; }
    const tk = hdr.indexOf(' ') > -1 ? hdr.split(' ')[1] : hdr;
    if (tk) { try { auth = $app.findAuthRecordByToken(tk); } catch (err) { auth = null; } }
  }
  if (!auth || !auth.id) throw new ForbiddenError('未登录');
  const org = String(auth.get('org_id') || '');
  if (!org) throw new BadRequestError('你还没有加入任何团队');

  let myRole = String(auth.get('role') || '');
  try {
    const m = $app.findFirstRecordByFilter('memberships',
      "user_id = '" + auth.id + "' && org_id = '" + org + "' && status = 'active'");
    if (m) myRole = String(m.get('role') || myRole);
  } catch (eR) {}
  if (myRole !== 'admin') throw new ForbiddenError('只有管理员可以移出成员');

  const data = new DynamicModel({ user_id: '' });
  e.bindBody(data);
  const uid = String(data.user_id || '');
  if (!uid) throw new BadRequestError('缺少 user_id');
  if (uid === String(auth.id)) throw new BadRequestError('不能移出自己，请使用「退出团队」');

  let mem = null;
  try {
    mem = $app.findFirstRecordByFilter('memberships',
      "user_id = '" + uid + "' && org_id = '" + org + "' && status = 'active'");
  } catch (eM) { mem = null; }
  if (!mem) throw new NotFoundError('该成员不在团队中');

  // 保底：不能把最后一个管理员移出
  if (String(mem.get('role') || '') === 'admin') {
    let admins = [];
    try {
      admins = $app.findRecordsByFilter('memberships',
        "org_id = '" + org + "' && status = 'active' && role = 'admin'", '', 50, 0);
    } catch (eA) { admins = []; }
    if (admins.length <= 1) throw new BadRequestError('不能移出团队唯一的管理员');
  }

  mem.set('status', 'removed');
  $app.save(mem);

  // 被移出者若正把本团队当激活团队 → 帮他切走或清空，否则他还能继续读写本团队数据
  try {
    const tu = $app.findRecordById('users', uid);
    if (String(tu.get('org_id') || '') === org) {
      let others = [];
      try {
        others = $app.findRecordsByFilter('memberships',
          "user_id = '" + uid + "' && status = 'active'", '-created', 20, 0);
      } catch (eO) { others = []; }
      if (others.length) {
        tu.set('org_id', String(others[0].get('org_id') || ''));
        tu.set('role', String(others[0].get('role') || 'reader'));
      } else {
        tu.set('org_id', '');
        tu.set('role', '');
      }
      $app.save(tu);
    }
  } catch (eU) {}

  return e.json(200, { ok: true, removed: uid });
});


// ---------------------------------------------------------------------------
// 7) POST /api/org/set-role —— 改成员角色 / 转让管理员（决策 3 的连带项）
//    body: { user_id, role }
//    安全闸：不能改自己的角色；改完必须仍有 ≥1 个管理员
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/org/set-role', (e) => {
  let auth = e.auth;
  if (!auth || !auth.id) {
    let hdr = '';
    try { hdr = e.request.header.get('Authorization') || ''; } catch (eH) { hdr = ''; }
    const tk = hdr.indexOf(' ') > -1 ? hdr.split(' ')[1] : hdr;
    if (tk) { try { auth = $app.findAuthRecordByToken(tk); } catch (err) { auth = null; } }
  }
  if (!auth || !auth.id) throw new ForbiddenError('未登录');
  const org = String(auth.get('org_id') || '');
  if (!org) throw new BadRequestError('你还没有加入任何团队');

  let myRole = String(auth.get('role') || '');
  try {
    const m = $app.findFirstRecordByFilter('memberships',
      "user_id = '" + auth.id + "' && org_id = '" + org + "' && status = 'active'");
    if (m) myRole = String(m.get('role') || myRole);
  } catch (eR) {}
  if (myRole !== 'admin') throw new ForbiddenError('只有管理员可以调整角色');

  const data = new DynamicModel({ user_id: '', role: '' });
  e.bindBody(data);
  const uid = String(data.user_id || '');
  const role = String(data.role || '');
  const ALLOWED = ['admin', 'pm', 'designer', 'finance', 'purchaser', 'qa', 'reader'];
  if (!uid) throw new BadRequestError('缺少 user_id');
  if (ALLOWED.indexOf(role) === -1) throw new BadRequestError('角色不合法');
  // 禁止改自己：避免管理员手滑把自己降级后再也改不回来
  if (uid === String(auth.id)) throw new BadRequestError('不能修改自己的角色，请让另一位管理员操作');

  let mem = null;
  try {
    mem = $app.findFirstRecordByFilter('memberships',
      "user_id = '" + uid + "' && org_id = '" + org + "' && status = 'active'");
  } catch (eM) { mem = null; }
  if (!mem) throw new NotFoundError('该成员不在团队中');

  const oldRole = String(mem.get('role') || '');
  if (oldRole === 'admin' && role !== 'admin') {
    let admins = [];
    try {
      admins = $app.findRecordsByFilter('memberships',
        "org_id = '" + org + "' && status = 'active' && role = 'admin'", '', 50, 0);
    } catch (eA) { admins = []; }
    if (admins.length <= 1) throw new BadRequestError('团队必须保留至少一个管理员');
  }

  mem.set('role', role);
  $app.save(mem);

  /* #424 审计：记录角色变更（失败开放） */
  try {
    const __c = $app.findCollectionByNameOrId('audit_logs');
    if (__c) {
      const __r = new Record(__c);
      __r.set('org_id', org);
      __r.set('actor_id', auth.id || '');
      let __nm = ''; try { __nm = (auth.get('display_name') || auth.get('email') || ''); } catch (eN) {}
      __r.set('actor_name', __nm);
      __r.set('action', 'set_role');
      __r.set('target', uid);
      __r.set('detail', oldRole + ' → ' + role);
      $app.save(__r);
    }
  } catch (eA) { console.warn('[audit] 角色变更审计写入失败（已忽略）：', eA); }

  // users.role 是「激活团队角色」缓存，目标用户正激活本团队时必须同步，否则权限判定会串
  try {
    const tu = $app.findRecordById('users', uid);
    if (String(tu.get('org_id') || '') === org) {
      tu.set('role', role);
      $app.save(tu);
    }
  } catch (eU) {}

  return e.json(200, { ok: true, user_id: uid, role: role, old_role: oldRole });
});


// ---------------------------------------------------------------------------
// 8) GET /api/org/list —— 我加入的所有团队（多团队切换下拉的数据源）
// ---------------------------------------------------------------------------
routerAdd('GET', '/api/org/list', (e) => {
  let auth = e.auth;
  if (!auth || !auth.id) {
    let hdr = '';
    try { hdr = e.request.header.get('Authorization') || ''; } catch (eH) { hdr = ''; }
    const tk = hdr.indexOf(' ') > -1 ? hdr.split(' ')[1] : hdr;
    if (tk) { try { auth = $app.findAuthRecordByToken(tk); } catch (err) { auth = null; } }
  }
  if (!auth || !auth.id) throw new ForbiddenError('未登录');
  const cur = String(auth.get('org_id') || '');

  let rows = [];
  try {
    rows = $app.findRecordsByFilter('memberships',
      "user_id = '" + auth.id + "' && status = 'active'", 'created', 50, 0);
  } catch (eL) { rows = []; }

  const out = [];
  let seenCur = false;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const oid = String(r.get('org_id') || '');
    if (!oid) continue;
    let name = '';
    let plan = '';
    let ostatus = '';
    try {
      const o = $app.findRecordById('organizations', oid);
      name = String(o.get('name') || '');
      plan = String(o.get('plan') || '');
      ostatus = String(o.get('status') || '');
    } catch (eO) {}
    if (oid === cur) seenCur = true;
    out.push({
      org_id: oid,
      org_name: name,
      plan: plan,
      org_status: ostatus,
      role: String(r.get('role') || ''),
      joined_at: String(r.get('joined_at') || r.get('created') || ''),
      is_current: oid === cur
    });
  }

  // 兜底：memberships 未回填但 users.org_id 有值 → 至少把当前团队列出来，下拉不空
  if (cur && !seenCur) {
    let name = '';
    let plan = '';
    let ostatus = '';
    try {
      const o = $app.findRecordById('organizations', cur);
      name = String(o.get('name') || '');
      plan = String(o.get('plan') || '');
      ostatus = String(o.get('status') || '');
    } catch (eO) {}
    out.push({
      org_id: cur,
      org_name: name,
      plan: plan,
      org_status: ostatus,
      role: String(auth.get('role') || ''),
      joined_at: '',
      is_current: true,
      degraded: true
    });
  }
  return e.json(200, { ok: true, current_org_id: cur, orgs: out });
});


// ---------------------------------------------------------------------------
// 9) POST /api/org/switch —— 切换当前激活团队
//    body: { org_id }
//    ⚠️ 切换团队 ≡ 换租户 ≡ 等价于换账号。服务端只负责把 users.org_id / users.role
//       改过去；**前端必须先把当前团队的脏数据推完、再置 __switching 硬闸门、
//       清空本地 App、然后「先拉后推」**，否则会把 A 团队数据写进 B 团队。
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/org/switch', (e) => {
  let auth = e.auth;
  if (!auth || !auth.id) {
    let hdr = '';
    try { hdr = e.request.header.get('Authorization') || ''; } catch (eH) { hdr = ''; }
    const tk = hdr.indexOf(' ') > -1 ? hdr.split(' ')[1] : hdr;
    if (tk) { try { auth = $app.findAuthRecordByToken(tk); } catch (err) { auth = null; } }
  }
  if (!auth || !auth.id) throw new ForbiddenError('未登录');

  const data = new DynamicModel({ org_id: '' });
  e.bindBody(data);
  const target = String(data.org_id || '');
  if (!target) throw new BadRequestError('缺少 org_id');

  if (String(auth.get('org_id') || '') === target) {
    // 幂等：已经在目标团队
    let nm = '';
    try { nm = String($app.findRecordById('organizations', target).get('name') || ''); } catch (eN) {}
    return e.json(200, { ok: true, already: true, org_id: target, org_name: nm, role: String(auth.get('role') || '') });
  }

  let mem = null;
  try {
    mem = $app.findFirstRecordByFilter('memberships',
      "user_id = '" + auth.id + "' && org_id = '" + target + "' && status = 'active'");
  } catch (eM) { mem = null; }
  if (!mem) throw new ForbiddenError('你不在该团队中，无法切换');

  let orgName = '';
  let orgStatus = '';
  let plan = '';
  try {
    const o = $app.findRecordById('organizations', target);
    orgName = String(o.get('name') || '');
    orgStatus = String(o.get('status') || '');
    plan = String(o.get('plan') || '');
  } catch (eO) { throw new NotFoundError('团队不存在'); }
  // 冻结的公司不许切进去（与 /api/me 的 org_status 拦截保持一致）
  if (orgStatus && orgStatus !== 'active') {
    throw new BadRequestError('该团队已被冻结（' + orgStatus + '），无法切换');
  }

  const role = String(mem.get('role') || 'reader');
  auth.set('org_id', target);
  auth.set('role', role);
  $app.save(auth);

  return e.json(200, { ok: true, org_id: target, org_name: orgName, role: role, plan: plan });
});
