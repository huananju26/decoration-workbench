/// <reference path="../pb_data/types.d.ts" />
// 平台运营后台接口：列全部公司 / 冻结·解冻·续期
// 全部要求 users.platform_admin = true（在 PocketBase 后台手动勾选，不开放自助提权）
//
// ⚠️ PocketBase JSVM：每个路由回调在【独立 JS 上下文】执行，
//    顶层 function/var 跨路由不可见 —— 鉴权代码在每个路由里重复写一遍。

// ---------- 列全部公司（含成员数） ----------
routerAdd('GET', '/api/admin/orgs', (e) => {
  let auth = e.auth;
  if (!auth || !auth.id) {
    const hdr = e.request.header.get('Authorization') || '';
    const tk = hdr.indexOf(' ') > -1 ? hdr.split(' ')[1] : hdr;
    if (tk) { try { auth = $app.findAuthRecordByToken(tk); } catch (err) { auth = null; } }
  }
  if (!auth || !auth.id) throw new ForbiddenError('未登录');
  if (!auth.get('platform_admin')) throw new ForbiddenError('需要平台管理员权限');

  let rows = [];
  try {
    rows = $app.findRecordsByFilter('organizations', '', '-created', 200, 0);
  } catch (err) {
    try { rows = $app.findAllRecords('organizations'); } catch (e2) { rows = []; }
  }

  const items = [];
  for (let i = 0; i < rows.length; i++) {
    const o = rows[i];
    let members = 0;
    try {
      const us = $app.findRecordsByFilter('users', 'org_id = "' + o.id + '"', '-created', 500, 0);
      members = us.length;
    } catch (err) { members = 0; }
    items.push({
      id: o.id,
      name: String(o.get('name') || ''),
      plan: String(o.get('plan') || ''),
      status: String(o.get('status') || ''),
      paid_until: String(o.get('paid_until') || '').slice(0, 10),
      seat_admin: Number(o.get('seat_admin') || 0),
      seat_member: Number(o.get('seat_member') || 0),
      storage_used: Number(o.get('storage_used') || 0),
      storage_quota: Number(o.get('storage_quota') || 0),
      contact_name: String(o.get('contact_name') || ''),
      contact_phone: String(o.get('contact_phone') || ''),
      members: members,
      created: String(o.get('created') || '')
    });
  }
  return e.json(200, { items: items });
});

// ---------- 冻结 / 解冻 / 续期 ----------
routerAdd('POST', '/api/admin/org/update', (e) => {
  let auth = e.auth;
  if (!auth || !auth.id) {
    const hdr = e.request.header.get('Authorization') || '';
    const tk = hdr.indexOf(' ') > -1 ? hdr.split(' ')[1] : hdr;
    if (tk) { try { auth = $app.findAuthRecordByToken(tk); } catch (err) { auth = null; } }
  }
  if (!auth || !auth.id) throw new ForbiddenError('未登录');
  if (!auth.get('platform_admin')) throw new ForbiddenError('需要平台管理员权限');

  const data = new DynamicModel({ id: '', action: '', days: 0 });
  e.bindBody(data);

  if (!data.id || !/^[A-Za-z0-9]{10,32}$/.test(data.id)) throw new BadRequestError('公司 id 不正确');

  let org = null;
  try { org = $app.findRecordById('organizations', data.id); } catch (err) { org = null; }
  if (!org) throw new BadRequestError('公司不存在');

  if (data.action === 'suspend') {
    org.set('status', 'suspended');
  } else if (data.action === 'activate') {
    org.set('status', 'active');
  } else if (data.action === 'extend') {
    const raw = String(org.get('paid_until') || '').replace(' ', 'T');
    let base = null;
    if (raw) { try { base = new Date(raw); } catch (err) { base = null; } }
    if (!base || isNaN(base.getTime()) || base < new Date()) base = new Date();
    const d = Number(data.days || 0);
    if (!d || isNaN(d)) throw new BadRequestError('续期天数不正确');
    base.setDate(base.getDate() + d);
    org.set('paid_until', base.toISOString().slice(0, 10) + ' 00:00:00.000Z');
  } else {
    throw new BadRequestError('操作不正确');
  }

  $app.save(org);
  return e.json(200, {
    ok: true,
    status: String(org.get('status') || ''),
    paid_until: String(org.get('paid_until') || '').slice(0, 10)
  });
});
