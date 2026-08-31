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

  // 套餐目录（与 organizations.plan 的 select 取值一一对应）。
  // 每路由独立 JS 上下文，这里重复定义一次。
  const PLANS = {
    trial:      { label: '试用版', desc: '功能完整，14 天后需升级；1 管理员 / 2 成员 / 5 GB',    seat_admin: 1,  seat_member: 2,   storage_gb: 5 },
    starter:    { label: '基础版', desc: '适合个人工长 / 小团队；2 管理员 / 10 成员 / 20 GB',     seat_admin: 2,  seat_member: 10,  storage_gb: 20 },
    standard:   { label: '标准版', desc: '适合中小装修公司；5 管理员 / 30 成员 / 100 GB',         seat_admin: 5,  seat_member: 30,  storage_gb: 100 },
    enterprise: { label: '旗舰版', desc: '适合多门店连锁；20 管理员 / 100 成员 / 500 GB',         seat_admin: 20, seat_member: 100, storage_gb: 500 }
  };
  const planCatalog = [];
  for (const k in PLANS) {
    if (Object.prototype.hasOwnProperty.call(PLANS, k)) {
      planCatalog.push({
        value: k, label: PLANS[k].label, desc: PLANS[k].desc,
        seat_admin: PLANS[k].seat_admin, seat_member: PLANS[k].seat_member, storage_gb: PLANS[k].storage_gb
      });
    }
  }

  const items = [];
  for (let i = 0; i < rows.length; i++) {
    const o = rows[i];
    let members = 0;
    try {
      const us = $app.findRecordsByFilter('users', 'org_id = "' + o.id + '"', '-created', 500, 0);
      members = us.length;
    } catch (err) { members = 0; }
    const planKey = String(o.get('plan') || 'trial');
    const pm = PLANS[planKey] || PLANS.trial;
    const isPaid = planKey !== 'trial';
    items.push({
      id: o.id,
      name: String(o.get('name') || ''),
      plan: planKey,
      plan_label: pm.label,
      plan_desc: pm.desc,
      is_paid: isPaid,
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
  return e.json(200, { items: items, plans: planCatalog });
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

  const data = new DynamicModel({ id: '', action: '', days: 0, plan: '', expiry: '' });
  e.bindBody(data);

  if (!data.id || !/^[A-Za-z0-9]{10,32}$/.test(data.id)) throw new BadRequestError('公司 id 不正确');

  let org = null;
  try { org = $app.findRecordById('organizations', data.id); } catch (err) { org = null; }
  if (!org) throw new BadRequestError('公司不存在');

  // 套餐目录（与 GET /api/admin/orgs 保持一致；每路由独立上下文，重复定义）
  const PLANS = {
    trial:      { seat_admin: 1,  seat_member: 2,   storage_gb: 5 },
    starter:    { seat_admin: 2,  seat_member: 10,  storage_gb: 20 },
    standard:   { seat_admin: 5,  seat_member: 30,  storage_gb: 100 },
    enterprise: { seat_admin: 20, seat_member: 100, storage_gb: 500 }
  };

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
  } else if (data.action === 'set_plan') {
    const np = String(data.plan || '');
    if (!PLANS[np]) throw new BadRequestError('套餐不正确');
    const std = PLANS[np];
    // 应用该套餐的配套标准（席位 + 存储额度）
    org.set('plan', np);
    org.set('seat_admin', std.seat_admin);
    org.set('seat_member', std.seat_member);
    org.set('storage_quota', std.storage_gb * 1024 * 1024 * 1024);
    // 状态切回正常；到期日只在「当前已过期 / 无值」时重写，避免缩短已付费周期
    org.set('status', 'active');
    const now = new Date();
    const curRaw = String(org.get('paid_until') || '').replace(' ', 'T');
    let curDate = null;
    if (curRaw) { try { curDate = new Date(curRaw); } catch (err) { curDate = null; } }
    if (!curDate || isNaN(curDate.getTime()) || curDate < now) {
      const add = np === 'trial' ? 14 : 365;
      now.setDate(now.getDate() + add);
      org.set('paid_until', now.toISOString().slice(0, 10) + ' 00:00:00.000Z');
    }
  } else if (data.action === 'set_expiry') {
    // 平台管理员手动设定公司到期日（精确覆盖 paid_until）
    const exp = String(data.expiry || '').trim();
    if (!exp) throw new BadRequestError('请填写到期日期');
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(exp);
    if (!m) throw new BadRequestError('日期格式应为 YYYY-MM-DD');
    const yy = Number(m[1]), mm = Number(m[2]), dd = Number(m[3]);
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) throw new BadRequestError('日期不合法');
    org.set('status', 'active');
    org.set('paid_until', exp + ' 00:00:00.000Z');
  } else {
    throw new BadRequestError('操作不正确');
  }

  $app.save(org);
  const planKey = String(org.get('plan') || 'trial');
  return e.json(200, {
    ok: true,
    plan: planKey,
    is_paid: planKey !== 'trial',
    status: String(org.get('status') || ''),
    paid_until: String(org.get('paid_until') || '').slice(0, 10),
    seat_admin: Number(org.get('seat_admin') || 0),
    seat_member: Number(org.get('seat_member') || 0),
    storage_quota: Number(org.get('storage_quota') || 0)
  });
});

// ---------- 列全部成员（含所属公司） ----------
routerAdd('GET', '/api/admin/members', (e) => {
  let auth = e.auth;
  if (!auth || !auth.id) {
    const hdr = e.request.header.get('Authorization') || '';
    const tk = hdr.indexOf(' ') > -1 ? hdr.split(' ')[1] : hdr;
    if (tk) { try { auth = $app.findAuthRecordByToken(tk); } catch (err) { auth = null; } }
  }
  if (!auth || !auth.id || !auth.get('platform_admin')) throw new ForbiddenError('需要平台管理员权限');

  var items = [];
  try {
    var rows = $app.findRecordsByFilter('users', '1=1', '-created', 2000, 0);
    for (var i = 0; i < rows.length; i++) {
      var u = rows[i];
      var orgId = u.get('org_id') || '';
      var orgName = '';
      var orgPlan = '';
      var orgStatus = '';
      if (orgId) {
        try {
          var o = $app.findRecordById('organizations', orgId);
          orgName = String(o.get('name') || '');
          orgPlan = String(o.get('plan') || '');
          orgStatus = String(o.get('status') || '');
        } catch (err2) {}
      }
      items.push({
        id: u.id,
        email: String(u.get('email') || ''),
        display_name: String(u.get('display_name') || ''),
        role: String(u.get('role') || ''),
        org_id: orgId,
        org_name: orgName,
        org_plan: orgPlan,
        org_status: orgStatus,
        platform_admin: !!u.get('platform_admin'),
        created: String(u.get('created') || '')
      });
    }
  } catch (err) {}
  return e.json(200, { items: items, total: items.length });
});
