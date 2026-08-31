/// <reference path="../pb_data/types.d.ts" />
// 审核制：提交申请 / 列申请 / 审核申请
//
// ⚠️ PocketBase JSVM 三大坑（本项目已栽过）：
//   1) 每个路由回调在【独立 JS 上下文】执行 —— 顶层 function/var 在别的路由里拿不到。
//      所以下面每个路由都把「取身份」的几行重复写了一遍，不要去抽取公共函数。
//   2) 改写字段一律走 routerAdd + $app.save()，不用任何记录钩子。
//   3) access_requests 表规则全部是 null，客户端只能经由本文件的路由操作。
//
// 权限矩阵：
//   提交申请        任何已登录、且尚无公司的用户
//   看自己的申请    本人（scope=mine）
//   看加入申请      该公司的 admin（scope=join），且不能跨公司
//   看开通申请      仅 platform_admin（scope=org）
//   审加入申请      该公司的 admin
//   审开通申请      仅 platform_admin

// ---------- 提交申请 ----------
routerAdd('POST', '/api/request/submit', (e) => {
  let auth = e.auth;
  if (!auth || !auth.id) {
    const hdr = e.request.header.get('Authorization') || '';
    const tk = hdr.indexOf(' ') > -1 ? hdr.split(' ')[1] : hdr;
    if (tk) { try { auth = $app.findAuthRecordByToken(tk); } catch (err) { auth = null; } }
  }
  if (!auth || !auth.id) throw new ForbiddenError('未登录');
  if (auth.get('org_id')) throw new BadRequestError('你已属于某个公司，无需再申请');

  const data = new DynamicModel({
    type: '', token: '', org_name: '', contact_name: '', contact_phone: '', message: ''
  });
  e.bindBody(data);

  if (data.type !== 'org' && data.type !== 'join') throw new BadRequestError('申请类型不正确');

  let dup = [];
  try {
    dup = $app.findRecordsByFilter(
      'access_requests', 'user_id = "' + auth.id + '" && status = "pending"', '-created', 1, 0);
  } catch (err) { dup = []; }
  if (dup.length) throw new BadRequestError('你已有一份待审核的申请，请等待审核结果');

  const col = $app.findCollectionByNameOrId('access_requests');
  const rec = new Record(col);
  rec.set('type', data.type);
  rec.set('user_id', auth.id);
  rec.set('status', 'pending');
  rec.set('message', data.message || '');

  if (data.type === 'join') {
    if (!data.token) throw new BadRequestError('请填写邀请码');
    if (!/^[A-Za-z0-9]{16,64}$/.test(data.token)) throw new BadRequestError('邀请码格式不正确');
    let inv = null;
    try {
      inv = $app.findFirstRecordByFilter('invitations', "token = '" + data.token + "'");
    } catch (err) { inv = null; }
    if (!inv) throw new BadRequestError('邀请码无效');
    if (inv.get('accepted')) throw new BadRequestError('该邀请码已被使用');
    const exp = String(inv.get('expires') || '').replace(' ', 'T');
    if (exp && new Date(exp) < new Date()) throw new BadRequestError('邀请码已过期');
    rec.set('org_id', inv.get('org_id'));
    rec.set('role', inv.get('role') || 'member');
  } else {
    const nm = (data.org_name || '').trim();
    if (!nm) throw new BadRequestError('请填写公司名称');
    rec.set('org_name', nm);
    rec.set('contact_name', data.contact_name || auth.get('display_name') || '');
    rec.set('contact_phone', data.contact_phone || auth.get('phone') || '');
    rec.set('role', 'admin');
  }

  $app.save(rec);
  return e.json(200, { id: rec.id, status: 'pending', type: data.type });
});

// ---------- 列申请（scope = mine | join | org） ----------
routerAdd('GET', '/api/request/list', (e) => {
  let auth = e.auth;
  if (!auth || !auth.id) {
    const hdr = e.request.header.get('Authorization') || '';
    const tk = hdr.indexOf(' ') > -1 ? hdr.split(' ')[1] : hdr;
    if (tk) { try { auth = $app.findAuthRecordByToken(tk); } catch (err) { auth = null; } }
  }
  if (!auth || !auth.id) throw new ForbiddenError('未登录');

  const scope = String(e.request.url.query().get('scope') || 'mine');

  let filter = '';
  if (scope === 'mine') {
    filter = 'user_id = "' + auth.id + '"';
  } else if (scope === 'join') {
    const org = auth.get('org_id');
    if (!org) throw new BadRequestError('你还没有公司');
    if (auth.get('role') !== 'admin') throw new ForbiddenError('只有管理员可以查看加入申请');
    filter = 'org_id = "' + org + '" && type = "join"';
  } else if (scope === 'org') {
    if (!auth.get('platform_admin')) throw new ForbiddenError('只有平台管理员可以查看开通申请');
    filter = 'type = "org"';
  } else {
    throw new BadRequestError('scope 不正确');
  }

  const st = String(e.request.url.query().get('status') || '');
  if (st === 'pending' || st === 'approved' || st === 'rejected') {
    filter += ' && status = "' + st + '"';
  }

  let rows = [];
  try { rows = $app.findRecordsByFilter('access_requests', filter, '-created', 100, 0); } catch (err) { rows = []; }

  const items = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    let who = '', email = '';
    const uid = r.get('user_id');
    if (uid) {
      try {
        const u = $app.findRecordById('users', uid);
        who = u.get('display_name') || '';
        email = u.get('email') || '';
      } catch (err) {}
    }
    let orgName = '';
    const oid = r.get('org_id');
    if (oid) { try { orgName = $app.findRecordById('organizations', oid).get('name') || ''; } catch (err) {} }
    items.push({
      id: r.id,
      type: r.get('type') || '',
      status: r.get('status') || 'pending',
      org_id: oid || '',
      org_name: orgName || r.get('org_name') || '',
      role: r.get('role') || 'member',
      user_name: who,
      user_email: email,
      contact_name: r.get('contact_name') || '',
      contact_phone: r.get('contact_phone') || '',
      message: r.get('message') || '',
      review_note: r.get('review_note') || '',
      created: String(r.get('created') || '')
    });
  }
  return e.json(200, { items: items });
});

// ---------- 审核（approve / reject） ----------
routerAdd('POST', '/api/request/review', (e) => {
  let auth = e.auth;
  if (!auth || !auth.id) {
    const hdr = e.request.header.get('Authorization') || '';
    const tk = hdr.indexOf(' ') > -1 ? hdr.split(' ')[1] : hdr;
    if (tk) { try { auth = $app.findAuthRecordByToken(tk); } catch (err) { auth = null; } }
  }
  if (!auth || !auth.id) throw new ForbiddenError('未登录');

  const data = new DynamicModel({ id: '', action: '', note: '' });
  e.bindBody(data);

  if (!data.id || !/^[A-Za-z0-9]{10,32}$/.test(data.id)) throw new BadRequestError('申请 id 不正确');
  if (data.action !== 'approve' && data.action !== 'reject') throw new BadRequestError('操作不正确');

  let rec = null;
  try { rec = $app.findRecordById('access_requests', data.id); } catch (err) { rec = null; }
  if (!rec) throw new BadRequestError('申请不存在');
  if (rec.get('status') !== 'pending') throw new BadRequestError('该申请已处理过了');

  const typ = rec.get('type');

  if (typ === 'org') {
    if (!auth.get('platform_admin')) throw new ForbiddenError('只有平台管理员可以审核开通申请');
  } else {
    const org = auth.get('org_id');
    if (!org) throw new BadRequestError('你还没有公司');
    if (auth.get('role') !== 'admin') throw new ForbiddenError('只有管理员可以审核加入申请');
    if (org !== rec.get('org_id')) throw new ForbiddenError('不能审核其他公司的申请');
  }

  rec.set('reviewed_by', auth.id);
  rec.set('reviewed_at', new Date().toISOString().replace('T', ' '));
  rec.set('review_note', data.note || '');

  if (data.action === 'reject') {
    rec.set('status', 'rejected');
    $app.save(rec);
    return e.json(200, { ok: true, status: 'rejected' });
  }

  const uid = rec.get('user_id');
  if (!uid) throw new BadRequestError('申请缺少申请人');
  let target = null;
  try { target = $app.findRecordById('users', uid); } catch (err) { target = null; }
  if (!target) throw new BadRequestError('申请人不存在');
  if (target.get('org_id')) throw new BadRequestError('该用户已属于某个公司');

  let orgId = rec.get('org_id');
  if (typ === 'org') {
    const orgsCol = $app.findCollectionByNameOrId('organizations');
    const org = new Record(orgsCol);
    org.set('name', rec.get('org_name') || '未命名公司');
    org.set('contact_name', rec.get('contact_name') || '');
    org.set('contact_phone', rec.get('contact_phone') || '');
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
    orgId = org.id;
    rec.set('org_id', orgId);
    target.set('role', 'admin');
  } else {
    target.set('role', rec.get('role') || 'member');
  }

  target.set('org_id', orgId);
  $app.save(target);

  rec.set('status', 'approved');
  $app.save(rec);

  return e.json(200, { ok: true, status: 'approved', orgId: orgId });
});
