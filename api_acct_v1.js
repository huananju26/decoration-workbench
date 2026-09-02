/// <reference path="../pb_data/types.d.ts" />
//
// ============================================================================
// 账户聚合路由（#487）：改用户名 / 改密码 / 业主绑定装修公司
// 部署位置：/opt/pocketbase/pb_hooks/api_acct.pb.js
// ============================================================================
//
// 为什么存在：
//   ① users.updateRule 为空（仅 superuser 可改），前端直接 PATCH
//      /api/collections/users/records/{uid} 必报
//      "Only superusers can perform this action." —— 改名/改密码全挂。
//      这里走钩子路由（superuser 上下文），**绝不打开 updateRule**：
//      一旦打开 `@request.auth.id = id`，用户就能顺带改自己的 org_id / role 提权。
//   ② 业主绑定装修公司（client_bindings / client_bind_codes 两表）：
//      建表见 schema_patch_v5_client_bind.pb.js（cron 自建表 + 自我注销）。
//
// ⚠️ 写法铁律（pb-pitfalls ⑤）：JSVM 每个路由回调都是独立上下文，回调外的
//    function/const 一律不可见 —— 每个路由完全自包含，逐字重复取 auth 的代码。
// ============================================================================


// ---------------------------------------------------------------------------
// 1) POST /api/acct/profile —— 改用户名（同步 display_name）
//    body: { name }   3-20 字符，不含空格/@；全库唯一
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/acct/profile', (e) => {
  let auth = e.auth;
  if (!auth || !auth.id) {
    let hdr = '';
    try { hdr = e.request.header.get('Authorization') || ''; } catch (eH) { hdr = ''; }
    const tk = hdr.indexOf(' ') > -1 ? hdr.split(' ')[1] : hdr;
    if (tk) { try { auth = $app.findAuthRecordByToken(tk); } catch (err) { auth = null; } }
  }
  if (!auth || !auth.id) throw new ForbiddenError('未登录');

  const data = new DynamicModel({ name: '' });
  e.bindBody(data);
  const name = String(data.name || '').trim();
  if (name.length < 3 || name.length > 20 || /[\s@]/.test(name)) {
    throw new BadRequestError('用户名需要 3-20 个字符，且不能包含空格或 @');
  }

  /* 全库唯一（排除自己）。users 集合用内置 name 字段存登录名 */
  try {
    const dup = $app.findRecordsByFilter('users',
      'name = "' + name.replace(/"/g, '\\"') + '"', '', 2, 0);
    if (dup && dup.length > 0) {
      for (let i = 0; i < dup.length; i++) {
        if (String(dup[i].id) !== String(auth.id)) {
          throw new BadRequestError('该用户名已被占用，请换一个');
        }
      }
    }
  } catch (err) {
    if (String(err.message || err).indexOf('已被占用') > -1) throw err;
    throw new BadRequestError('用户名唯一性校验失败，请稍后重试');
  }

  try {
    auth.set('name', name);
    /* display_name 是 UI 展示名：跟着用户名走，保证侧栏/弹窗立即生效 */
    auth.set('display_name', name);
    $app.save(auth);
  } catch (err) {
    throw new BadRequestError('保存失败：' + String(err && err.message ? err.message : err));
  }
  return e.json(200, { ok: true, name: name, display_name: name });
});


// ---------------------------------------------------------------------------
// 2) POST /api/acct/password —— 改密码（校验旧密码；tokenKey 不动，本会话不掉线）
//    body: { old_password, new_password }
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/acct/password', (e) => {
  let auth = e.auth;
  if (!auth || !auth.id) {
    let hdr = '';
    try { hdr = e.request.header.get('Authorization') || ''; } catch (eH) { hdr = ''; }
    const tk = hdr.indexOf(' ') > -1 ? hdr.split(' ')[1] : hdr;
    if (tk) { try { auth = $app.findAuthRecordByToken(tk); } catch (err) { auth = null; } }
  }
  if (!auth || !auth.id) throw new ForbiddenError('未登录');

  const data = new DynamicModel({ old_password: '', new_password: '' });
  e.bindBody(data);
  const oldPwd = String(data.old_password || '');
  const newPwd = String(data.new_password || '');
  if (!oldPwd) throw new BadRequestError('请输入当前密码');
  if (newPwd.length < 8) throw new BadRequestError('新密码至少 8 个字符');

  /* 旧密码校验：Record.validatePassword 是 types.d.ts 绑定的原生方法 */
  let oldOk = false;
  try {
    if (typeof auth.validatePassword === 'function') oldOk = auth.validatePassword(oldPwd);
    else throw new Error('validatePassword 不可用');
  } catch (err) {
    if (String(err.message || err).indexOf('不可用') > -1) {
      throw new BadRequestError('服务器暂不支持旧密码校验，请联系管理员');
    }
    oldOk = false;
  }
  if (!oldOk) throw new BadRequestError('当前密码不正确');

  try {
    /* set('password') 会被 PB auth 记录拦截并自动哈希（同 /api/auth/register） */
    auth.set('password', newPwd);
    $app.save(auth);
  } catch (err) {
    throw new BadRequestError('密码保存失败：' + String(err && err.message ? err.message : err));
  }
  return e.json(200, { ok: true });
});


// ---------------------------------------------------------------------------
// 3) GET /api/client/bindcode —— 公司管理员：获取/生成本公司业主绑定码
//    依赖 client_bind_codes 集合（schema_patch_v5 建）
// ---------------------------------------------------------------------------
routerAdd('GET', '/api/client/bindcode', (e) => {
  let auth = e.auth;
  if (!auth || !auth.id) {
    let hdr = '';
    try { hdr = e.request.header.get('Authorization') || ''; } catch (eH) { hdr = ''; }
    const tk = hdr.indexOf(' ') > -1 ? hdr.split(' ')[1] : hdr;
    if (tk) { try { auth = $app.findAuthRecordByToken(tk); } catch (err) { auth = null; } }
  }
  if (!auth || !auth.id) throw new ForbiddenError('未登录');
  const org = String(auth.get('org_id') || '');
  if (!org) throw new BadRequestError('你还没有加入任何公司');

  let myRole = String(auth.get('role') || '');
  try {
    const m = $app.findFirstRecordByFilter('memberships',
      "user_id = '" + auth.id + "' && org_id = '" + org + "' && status = 'active'");
    if (m) myRole = String(m.get('role') || myRole);
  } catch (eR) {}
  if (myRole !== 'admin') throw new ForbiddenError('只有企业管理员可以管理业主绑定码');

  let orgName = '';
  try { orgName = String($app.findRecordById('organizations', org).get('name') || ''); } catch (eO) {}

  /* 已有直接返回；没有生成一个：HAJ-XXXX-XXXX（去掉易混字符 0/O/1/I） */
  let row = null;
  try {
    const rows = $app.findRecordsByFilter('client_bind_codes', "org_id = '" + org + "'", '', 1, 0);
    if (rows && rows.length > 0) row = rows[0];
  } catch (eF) {
    throw new BadRequestError('绑定码表未就绪：请确认 schema_patch_v5 已执行（重启后约 1 分钟）');
  }
  if (!row) {
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let s = 0; s < 2; s++) {
      if (code) code += '-';
      for (let i = 0; i < 4; i++) code += abc.charAt(Math.floor(Math.random() * abc.length));
    }
    const col = $app.findCollectionByNameOrId('client_bind_codes');
    const rec = new Record(col);
    rec.set('org', org);
    rec.set('code', code);
    try { $app.save(rec); } catch (err) {
      throw new BadRequestError('绑定码生成失败：' + String(err && err.message ? err.message : err));
    }
    row = rec;
  }
  return e.json(200, { ok: true, code: String(row.get('code') || ''), org_name: orgName });
});


// ---------------------------------------------------------------------------
// 4) POST /api/client/bind —— 业主：凭绑定码绑定装修公司
//    body: { code }   绑定码即授权（码由公司管理员保管、自愿提供）
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/client/bind', (e) => {
  let auth = e.auth;
  if (!auth || !auth.id) {
    let hdr = '';
    try { hdr = e.request.header.get('Authorization') || ''; } catch (eH) { hdr = ''; }
    const tk = hdr.indexOf(' ') > -1 ? hdr.split(' ')[1] : hdr;
    if (tk) { try { auth = $app.findAuthRecordByToken(tk); } catch (err) { auth = null; } }
  }
  if (!auth || !auth.id) throw new ForbiddenError('未登录');

  const data = new DynamicModel({ code: '' });
  e.bindBody(data);
  const code = String(data.code || '').trim().toUpperCase();
  if (!code) throw new BadRequestError('请输入绑定码');

  /* 公司成员不需要也不应该绑定（业主功能是给无公司账号的业主用的） */
  if (String(auth.get('org_id') || '')) {
    throw new BadRequestError('你已是公司成员，无需绑定装修公司');
  }

  let codeRow = null;
  try {
    const rows = $app.findRecordsByFilter('client_bind_codes',
      'code = "' + code.replace(/"/g, '\\"') + '"', '', 1, 0);
    if (rows && rows.length > 0) codeRow = rows[0];
  } catch (eF) {
    throw new BadRequestError('绑定码表未就绪：请确认 schema_patch_v5 已执行');
  }
  if (!codeRow) throw new NotFoundError('绑定码不存在，请向装修公司确认');

  const org = String(codeRow.get('org') || '');
  if (!org) throw new NotFoundError('绑定码无效');

  let orgName = '';
  try { orgName = String($app.findRecordById('organizations', org).get('name') || ''); } catch (eO) {}

  /* 幂等：重复绑定直接返回成功 */
  let existed = null;
  try {
    const rows2 = $app.findRecordsByFilter('client_bindings',
      "owner = '" + auth.id + "' && org = '" + org + "'", '', 1, 0);
    if (rows2 && rows2.length > 0) existed = rows2[0];
  } catch (eF2) {
    throw new BadRequestError('绑定表未就绪：请确认 schema_patch_v5 已执行');
  }
  if (existed) return e.json(200, { ok: true, already: true, id: String(existed.id), org_name: orgName });

  const col = $app.findCollectionByNameOrId('client_bindings');
  const rec = new Record(col);
  rec.set('owner', auth.id);
  rec.set('org', org);
  try { $app.save(rec); } catch (err) {
    throw new BadRequestError('绑定失败：' + String(err && err.message ? err.message : err));
  }
  return e.json(200, { ok: true, id: String(rec.id), org_name: orgName });
});


// ---------------------------------------------------------------------------
// 5) GET /api/client/bindings —— 业主：我绑定的装修公司列表
// ---------------------------------------------------------------------------
routerAdd('GET', '/api/client/bindings', (e) => {
  let auth = e.auth;
  if (!auth || !auth.id) {
    let hdr = '';
    try { hdr = e.request.header.get('Authorization') || ''; } catch (eH) { hdr = ''; }
    const tk = hdr.indexOf(' ') > -1 ? hdr.split(' ')[1] : hdr;
    if (tk) { try { auth = $app.findAuthRecordByToken(tk); } catch (err) { auth = null; } }
  }
  if (!auth || !auth.id) throw new ForbiddenError('未登录');

  let rows = [];
  try {
    rows = $app.findRecordsByFilter('client_bindings',
      "owner = '" + auth.id + "'", '-created', 100, 0);
  } catch (eF) {
    throw new BadRequestError('绑定表未就绪：请确认 schema_patch_v5 已执行');
  }
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const org = String(r.get('org') || '');
    let orgName = '';
    try { orgName = String($app.findRecordById('organizations', org).get('name') || ''); } catch (eO) {}
    out.push({
      id: String(r.id),
      org_id: org,
      org_name: orgName,
      created: String(r.get('created') || '')
    });
  }
  return e.json(200, { ok: true, items: out });
});


// ---------------------------------------------------------------------------
// 6) POST /api/client/unbind —— 业主：解绑（只能解自己的）
//    body: { id }
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/client/unbind', (e) => {
  let auth = e.auth;
  if (!auth || !auth.id) {
    let hdr = '';
    try { hdr = e.request.header.get('Authorization') || ''; } catch (eH) { hdr = ''; }
    const tk = hdr.indexOf(' ') > -1 ? hdr.split(' ')[1] : hdr;
    if (tk) { try { auth = $app.findAuthRecordByToken(tk); } catch (err) { auth = null; } }
  }
  if (!auth || !auth.id) throw new ForbiddenError('未登录');

  const data = new DynamicModel({ id: '' });
  e.bindBody(data);
  const id = String(data.id || '');
  if (!id) throw new BadRequestError('缺少绑定记录 ID');

  let rec = null;
  try { rec = $app.findRecordById('client_bindings', id); } catch (eF) { rec = null; }
  if (!rec) throw new NotFoundError('绑定记录不存在');
  if (String(rec.get('owner') || '') !== String(auth.id)) throw new NotFoundError('绑定记录不存在');

  $app.delete(rec);
  return e.json(200, { ok: true });
});


// ---------------------------------------------------------------------------
// 7) GET /api/client/owners —— 公司管理员：查看绑定了本公司的业主
// ---------------------------------------------------------------------------
routerAdd('GET', '/api/client/owners', (e) => {
  let auth = e.auth;
  if (!auth || !auth.id) {
    let hdr = '';
    try { hdr = e.request.header.get('Authorization') || ''; } catch (eH) { hdr = ''; }
    const tk = hdr.indexOf(' ') > -1 ? hdr.split(' ')[1] : hdr;
    if (tk) { try { auth = $app.findAuthRecordByToken(tk); } catch (err) { auth = null; } }
  }
  if (!auth || !auth.id) throw new ForbiddenError('未登录');
  const org = String(auth.get('org_id') || '');
  if (!org) throw new BadRequestError('你还没有加入任何公司');

  let myRole = String(auth.get('role') || '');
  try {
    const m = $app.findFirstRecordByFilter('memberships',
      "user_id = '" + auth.id + "' && org_id = '" + org + "' && status = 'active'");
    if (m) myRole = String(m.get('role') || myRole);
  } catch (eR) {}
  if (myRole !== 'admin') throw new ForbiddenError('只有企业管理员可以查看业主列表');

  let rows = [];
  try {
    rows = $app.findRecordsByFilter('client_bindings',
      "org = '" + org + "'", '-created', 500, 0);
  } catch (eF) {
    throw new BadRequestError('绑定表未就绪：请确认 schema_patch_v5 已执行');
  }
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    let name = '';
    let email = '';
    try {
      const u = $app.findRecordById('users', String(r.get('owner') || ''));
      name = String(u.get('display_name') || u.get('name') || '');
      email = String(u.get('email') || '');
    } catch (eU) {}
    out.push({
      id: String(r.id),
      owner_name: name,
      owner_email: email,
      created: String(r.get('created') || '')
    });
  }
  return e.json(200, { ok: true, items: out });
});
