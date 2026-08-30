// 部署位置：/opt/pocketbase/pb_hooks/api.pb.js
//
// ⚠️ 重要约束（实测得出，改本文件前必读）：
// 1. PocketBase 的 JSVM 里，**每个路由回调都在独立的 JS 上下文执行**，
//    顶层 function 声明、var、globalThis 挂载 —— 在回调里统统拿不到（会报 xxx is not defined）。
//    所以下面每个路由都是**完全自包含**的，不复用任何辅助函数。看着啰嗦，但这是唯一能跑的写法。
// 2. 不要注册 onRecordCreateRequest / onRecordUpdateRequest 这类记录钩子，
//    实测会让创建请求返回空响应且不落库。所有需要服务端改写字段的动作一律走下面的路由 + $app.save()。
// 3. 数据隔离由迁移里的 API Rule 保证：@request.body.org_id = @request.auth.org_id
//
// 统一约定：所有取当前用户的代码都是这三行，别再抽函数。
//   let auth = e.auth;
//   if (!auth || !auth.id) auth = (function(){ ...token... })();
//   if (!auth || !auth.id) throw new ForbiddenError('未登录');

// ---------- 探活 ----------
routerAdd('GET', '/api/ping', (e) => e.json(200, { ok: true, v: '1.0' }));

// ---------- 创建公司：首个注册的人成为管理员，开 14 天试用 ----------
routerAdd('POST', '/api/org/create', (e) => {
  let auth = e.auth;
  if (!auth || !auth.id) {
    const hdr = e.request.header.get('Authorization') || '';
    const tk = hdr.indexOf(' ') > -1 ? hdr.split(' ')[1] : hdr;
    if (tk) { try { auth = $app.findAuthRecordByToken(tk); } catch (err) { auth = null; } }
  }
  if (!auth || !auth.id) throw new ForbiddenError('未登录');
  if (auth.get('org_id')) throw new BadRequestError('你已经属于某个公司了');

  const data = new DynamicModel({ name: '', contact_name: '', contact_phone: '' });
  e.bindBody(data);
  if (!data.name) throw new BadRequestError('公司名不能为空');

  const orgsCol = $app.findCollectionByNameOrId('organizations');
  const org = new Record(orgsCol);
  org.set('name', data.name);
  org.set('contact_name', data.contact_name || auth.get('display_name') || '');
  org.set('contact_phone', data.contact_phone || auth.get('phone') || '');
  org.set('plan', 'trial');
  org.set('status', 'active');
  const d = new Date();
  d.setDate(d.getDate() + 14);
  org.set('paid_until', d.toISOString().slice(0, 10) + ' 00:00:00.000Z');
  org.set('seat_admin', 1);
  org.set('seat_member', 2);
  org.set('storage_used', 0);
  org.set('storage_quota', 5 * 1024 * 1024 * 1024);
  $app.save(org);

  auth.set('org_id', org.id);
  auth.set('role', 'admin');
  $app.save(auth);

  return e.json(200, { orgId: org.id, name: org.get('name'), plan: 'trial', role: 'admin' });
});

// ---------- 管理员生成邀请（返回令牌，自己发给同事） ----------
routerAdd('POST', '/api/org/invite', (e) => {
  let auth = e.auth;
  if (!auth || !auth.id) {
    const hdr = e.request.header.get('Authorization') || '';
    const tk = hdr.indexOf(' ') > -1 ? hdr.split(' ')[1] : hdr;
    if (tk) { try { auth = $app.findAuthRecordByToken(tk); } catch (err) { auth = null; } }
  }
  if (!auth || !auth.id) throw new ForbiddenError('未登录');
  if (auth.get('role') !== 'admin') throw new ForbiddenError('只有管理员可以邀请');
  const org = auth.get('org_id');
  if (!org) throw new BadRequestError('你还没有公司');

  const data = new DynamicModel({ role: 'member' });
  e.bindBody(data);

  const invCol = $app.findCollectionByNameOrId('invitations');
  const inv = new Record(invCol);
  inv.set('org_id', org);
  inv.set('email', '');
  inv.set('role', data.role || 'member');
  inv.set('token', $security.randomString(24));
  const d = new Date();
  d.setDate(d.getDate() + 7);
  inv.set('expires', d.toISOString().slice(0, 10) + ' 00:00:00.000Z');
  inv.set('accepted', false);
  $app.save(inv);

  return e.json(200, { token: inv.get('token'), expires: inv.get('expires') });
});

// ---------- 用邀请令牌加入公司 ----------
routerAdd('POST', '/api/org/accept', (e) => {
  let auth = e.auth;
  if (!auth || !auth.id) {
    const hdr = e.request.header.get('Authorization') || '';
    const tk = hdr.indexOf(' ') > -1 ? hdr.split(' ')[1] : hdr;
    if (tk) { try { auth = $app.findAuthRecordByToken(tk); } catch (err) { auth = null; } }
  }
  if (!auth || !auth.id) throw new ForbiddenError('未登录');
  if (auth.get('org_id')) throw new BadRequestError('你已经属于某个公司了');

  const data = new DynamicModel({ token: '' });
  e.bindBody(data);
  if (!data.token) throw new BadRequestError('缺少邀请令牌');

  let inv = null;
  try {
    inv = $app.findFirstRecordByFilter(
      'invitations', "token = '" + data.token + "' && accepted = false"
    );
  } catch (err) { inv = null; }
  if (!inv) throw new BadRequestError('邀请无效或已被使用');

  const exp = String(inv.get('expires') || '').replace(' ', 'T');
  if (exp && new Date(exp) < new Date()) throw new BadRequestError('邀请已过期');

  auth.set('org_id', inv.get('org_id'));
  auth.set('role', inv.get('role') || 'member');
  $app.save(auth);

  inv.set('accepted', true);
  $app.save(inv);

  return e.json(200, { orgId: inv.get('org_id'), role: auth.get('role') });
});

// ---------- 改个人资料（role / org_id 一律不允许改） ----------
routerAdd('POST', '/api/me/update', (e) => {
  let auth = e.auth;
  if (!auth || !auth.id) {
    const hdr = e.request.header.get('Authorization') || '';
    const tk = hdr.indexOf(' ') > -1 ? hdr.split(' ')[1] : hdr;
    if (tk) { try { auth = $app.findAuthRecordByToken(tk); } catch (err) { auth = null; } }
  }
  if (!auth || !auth.id) throw new ForbiddenError('未登录');

  const data = new DynamicModel({ display_name: '', phone: '' });
  e.bindBody(data);
  auth.set('display_name', data.display_name || auth.get('display_name') || '');
  auth.set('phone', data.phone || auth.get('phone') || '');
  $app.save(auth);

  return e.json(200, {
    ok: true,
    display_name: auth.get('display_name'),
    phone: auth.get('phone')
  });
});

// ---------- 当前身份速查（前端启动用） ----------
routerAdd('GET', '/api/me', (e) => {
  let auth = e.auth;
  if (!auth || !auth.id) {
    const hdr = e.request.header.get('Authorization') || '';
    const tk = hdr.indexOf(' ') > -1 ? hdr.split(' ')[1] : hdr;
    if (tk) { try { auth = $app.findAuthRecordByToken(tk); } catch (err) { auth = null; } }
  }
  if (!auth || !auth.id) return e.json(200, { signedIn: false });

  const org = auth.get('org_id');
  let orgName = '';
  let plan = '';
  let paidUntil = '';
  let seatAdmin = 0;
  let seatMember = 0;
  let storageUsed = 0;
  let storageQuota = 0;
  if (org) {
    try {
      const o = $app.findRecordById('organizations', org);
      orgName = String(o.get('name') || '');
      plan = String(o.get('plan') || '');
      paidUntil = String(o.get('paid_until') || '');
      seatAdmin = Number(o.get('seat_admin') || 0);
      seatMember = Number(o.get('seat_member') || 0);
      storageUsed = Number(o.get('storage_used') || 0);
      storageQuota = Number(o.get('storage_quota') || 0);
    } catch (err) {}
  }
  return e.json(200, {
    signedIn: true,
    id: auth.id,
    email: auth.get('email'),
    display_name: auth.get('display_name') || '',
    org_id: org || '',
    org_name: orgName,
    role: auth.get('role') || '',
    plan: plan,
    paid_until: paidUntil,
    seat_admin: seatAdmin,
    seat_member: seatMember,
    storage_used: storageUsed,
    storage_quota: storageQuota
  });
});

// ---------- 读取公司业务数据（整份 App） ----------
routerAdd('GET', '/api/data/load', (e) => {
  let auth = e.auth;
  if (!auth || !auth.id) {
    const hdr = e.request.header.get('Authorization') || '';
    const tk = hdr.indexOf(' ') > -1 ? hdr.split(' ')[1] : hdr;
    if (tk) { try { auth = $app.findAuthRecordByToken(tk); } catch (err) { auth = null; } }
  }
  if (!auth || !auth.id) throw new ForbiddenError('未登录');
  const org = auth.get('org_id');
  if (!org) return e.json(200, { has: false });

  let rec = null;
  try { rec = $app.findFirstRecordByFilter('org_data', 'org_id = "' + org + '"'); } catch (err) { rec = null; }
  if (!rec) return e.json(200, { has: false, rev: 0 });

  let who = '';
  const by = rec.get('updated_by');
  if (by) { try { const u = $app.findRecordById('users', by); who = u.get('display_name') || u.get('email') || ''; } catch (err) {} }
  return e.json(200, {
    has: true,
    rev: Number(rec.get('rev') || 0),
    data: rec.get('data'),
    updated: String(rec.get('updated') || ''),
    updated_by: who
  });
});

// ---------- 保存公司业务数据（乐观锁：rev 不匹配说明有人抢先改了） ----------
// 约定：客户端 pull 时记下 rev，push 时带回。
//   rev 一致 → 写入，rev+1
//   rev 不一致 → 409 + conflict:true（不静默覆盖，让前端弹冲突框）
//   force:true → 强制覆盖（用户在冲突框里选了「用我的」）
routerAdd('POST', '/api/data/save', (e) => {
  let auth = e.auth;
  if (!auth || !auth.id) {
    const hdr = e.request.header.get('Authorization') || '';
    const tk = hdr.indexOf(' ') > -1 ? hdr.split(' ')[1] : hdr;
    if (tk) { try { auth = $app.findAuthRecordByToken(tk); } catch (err) { auth = null; } }
  }
  if (!auth || !auth.id) throw new ForbiddenError('未登录');
  const org = auth.get('org_id');
  if (!org) throw new BadRequestError('你还没有加入公司');

  const info = e.requestInfo();
  const body = (info && info.body) ? info.body : {};
  const inRev = Number(body.rev || 0);
  const inData = body.data;
  const force = body.force === true || body.force === 'true';
  if (inData === null || inData === undefined) throw new BadRequestError('缺少 data');

  let rec = null;
  try { rec = $app.findFirstRecordByFilter('org_data', 'org_id = "' + org + '"'); } catch (err) { rec = null; }

  if (!rec) {
    const col = $app.findCollectionByNameOrId('org_data');
    rec = new Record(col);
    rec.set('org_id', org);
    rec.set('data', inData);
    rec.set('rev', 1);
    rec.set('updated_by', auth.id);
    $app.save(rec);
    return e.json(200, { ok: true, rev: 1, updated: String(rec.get('updated') || '') });
  }

  const cur = Number(rec.get('rev') || 0);
  if (!force && inRev !== cur) {
    let who = '同事';
    const by = rec.get('updated_by');
    if (by) { try { const u = $app.findRecordById('users', by); who = u.get('display_name') || u.get('email') || '同事'; } catch (err) {} }
    return e.json(409, {
      conflict: true,
      serverRev: cur,
      yourRev: inRev,
      updated: String(rec.get('updated') || ''),
      updated_by: who
    });
  }

  rec.set('data', inData);
  rec.set('rev', cur + 1);
  rec.set('updated_by', auth.id);
  $app.save(rec);
  return e.json(200, { ok: true, rev: cur + 1, updated: String(rec.get('updated') || '') });
});
