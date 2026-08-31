/// <reference path="../pb_data/types.d.ts" />
// 平台清理：体检（scan）+ 删除（purge）
//
// 设计原则：**自动体检、风险分级、人工确认**。宁可多留，绝不可误删。
// 删除是不可逆操作，所有「有数据 / 有成员 / 有付费」的对象一律默认拦下。
//
// ⚠️ PocketBase JSVM 三大坑（本项目已栽过，别再犯）：
//   1) 每个路由回调在【独立 JS 上下文】执行 —— 顶层 function/var 跨路由不可见。
//      下面每个路由都把「取身份」几行重复写一遍，不要去抽取公共函数。
//   2) 改写字段一律走 routerAdd + $app.save()，不用任何记录钩子。
//   3) access_requests / org_data / sync_units 规则为 null 或受限，
//      客户端只能经由路由操作，所以这里用 $app.* 直接读写。
//
// 分级含义（前端据此决定默认是否勾选）：
//   safe  = 空壳，删掉零损失（无成员/无数据/无付费）
//   warn  = 有业务数据，删掉会一起清空，需要人工确认
//   block = 有成员或付费记录，禁止删除（即使 force 也不删付费的）

// ---------- 体检：列出可清理候选 ----------
routerAdd('POST', '/api/admin/scan', (e) => {
  let auth = e.auth;
  if (!auth || !auth.id) {
    const hdr = e.request.header.get('Authorization') || '';
    const tk = hdr.indexOf(' ') > -1 ? hdr.split(' ')[1] : hdr;
    if (tk) { try { auth = $app.findAuthRecordByToken(tk); } catch (err) { auth = null; } }
  }
  if (!auth || !auth.id) throw new ForbiddenError('未登录');
  if (!auth.get('platform_admin')) throw new ForbiddenError('需要平台管理员权限');

  const body = new DynamicModel({ days: 0 });
  e.bindBody(body);
  const days = Number(body.days) > 0 ? Number(body.days) : 7;
  const now = Date.now();
  const dayMs = 86400000;

  // ---- 用户：只看「没有公司」的孤儿账号（有公司的在下面按公司维度处理） ----
  const users = [];
  let urows = [];
  try {
    urows = $app.findRecordsByFilter('users', 'org_id = ""', '-created', 500, 0);
  } catch (err) { urows = []; }

  for (let i = 0; i < urows.length; i++) {
    const u = urows[i];
    const cr = String(u.get('created') || '').replace(' ', 'T');
    let age = 0;
    if (cr) { try { age = Math.floor((now - new Date(cr).getTime()) / dayMs); } catch (err) { age = 0; } }

    const mail = String(u.get('email') || '');
    const isTest = /^(test|demo|tmp|zz)[_\-.]/i.test(mail) || /@(example|test)\.(com|cn)$/i.test(mail);
    const isSelf = u.id === auth.id;
    const isAdmin = !!u.get('platform_admin');

    let reqs = 0;
    try {
      reqs = $app.findRecordsByFilter(
        'access_requests', 'user_id = "' + u.id + '" && status = "pending"', '-created', 10, 0).length;
    } catch (err) { reqs = 0; }

    const reasons = [];
    let level = 'safe';
    if (isSelf) {
      level = 'block';
      reasons.push('这是你自己的账号');
    } else if (isAdmin) {
      level = 'block';
      reasons.push('平台管理员，受保护');
    } else {
      if (age >= days) reasons.push('注册 ' + age + ' 天仍未加入公司');
      if (isTest) reasons.push('测试邮箱');
      if (reqs) {
        reasons.push('有 ' + reqs + ' 条待审申请，删掉会一并撤销');
        level = 'warn';
      }
      if (!reasons.length) {
        reasons.push('刚注册、暂无迹可循');
        level = 'warn';
      }
    }

    users.push({
      id: u.id,
      email: mail,
      name: String(u.get('display_name') || ''),
      age: age,
      pending: reqs,
      test: isTest,
      created: String(u.get('created') || ''),
      level: level,
      reasons: reasons
    });
  }

  // ---- 公司：按「有没有数据 / 有没有人 / 有没有付过钱」分级 ----
  const orgs = [];
  let orows = [];
  try { orows = $app.findRecordsByFilter('organizations', '', '-created', 300, 0); } catch (err) { orows = []; }

  for (let i = 0; i < orows.length; i++) {
    const o = orows[i];

    let members = 0;
    try {
      members = $app.findRecordsByFilter('users', 'org_id = "' + o.id + '"', '-created', 500, 0).length;
    } catch (err) { members = 0; }

    let units = 0;
    try {
      units = $app.findRecordsByFilter('sync_units', 'org_id = "' + o.id + '"', '', 500, 0).length;
    } catch (err) { units = 0; }

    let drows = [];
    try { drows = $app.findRecordsByFilter('org_data', 'org_id = "' + o.id + '"', '', 5, 0); } catch (err) { drows = []; }
    let bytes = 0;
    for (let k = 0; k < drows.length; k++) {
      try { bytes += String(drows[k].get('data') || '').length; } catch (err) { bytes += 0; }
    }

    let paid = 0;
    try {
      paid = $app.findRecordsByFilter('orders', 'org_id = "' + o.id + '" && status = "paid"', '', 50, 0).length;
    } catch (err) { paid = 0; }

    let subs = 0;
    try {
      subs = $app.findRecordsByFilter('subscriptions', 'org_id = "' + o.id + '"', '', 50, 0).length;
    } catch (err) { subs = 0; }

    const reasons = [];
    let level = 'safe';
    if (paid > 0 || subs > 0) {
      level = 'block';
      reasons.push('有付费/订阅记录');
    }
    if (members > 0) {
      level = 'block';
      reasons.push('有 ' + members + ' 名成员');
    }
    if (level === 'safe') {
      if (units > 0 || bytes > 0) {
        level = 'warn';
        reasons.push('有业务数据（' + units + ' 个同步单元 / 整包 ' + Math.round(bytes / 1024) + ' KB），删除将一并清空');
      } else {
        reasons.push('0 成员');
        reasons.push('无任何业务数据');
      }
    }

    orgs.push({
      id: o.id,
      name: String(o.get('name') || ''),
      created: String(o.get('created') || ''),
      members: members,
      units: units,
      bytes: bytes,
      paid: (paid + subs) > 0,
      plan: String(o.get('plan') || ''),
      status: String(o.get('status') || ''),
      level: level,
      reasons: reasons
    });
  }

  return e.json(200, { days: days, users: users, orgs: orgs });
});

// ---------- 删除：只删通过安全检查的对象 ----------
routerAdd('POST', '/api/admin/purge', (e) => {
  let auth = e.auth;
  if (!auth || !auth.id) {
    const hdr = e.request.header.get('Authorization') || '';
    const tk = hdr.indexOf(' ') > -1 ? hdr.split(' ')[1] : hdr;
    if (tk) { try { auth = $app.findAuthRecordByToken(tk); } catch (err) { auth = null; } }
  }
  if (!auth || !auth.id) throw new ForbiddenError('未登录');
  if (!auth.get('platform_admin')) throw new ForbiddenError('需要平台管理员权限');

  // ids 用逗号分隔的字符串传（DynamicModel 绑数组在不同版本表现不一致，字符串最稳）
  const data = new DynamicModel({ user_ids: '', org_ids: '', force: false });
  e.bindBody(data);

  const IDRE = /^[A-Za-z0-9]{10,32}$/;
  const uids = String(data.user_ids || '').split(',').map((s) => String(s || '').trim()).filter((s) => IDRE.test(s));
  const oids = String(data.org_ids || '').split(',').map((s) => String(s || '').trim()).filter((s) => IDRE.test(s));

  if (!uids.length && !oids.length) throw new BadRequestError('没有选中任何对象');

  const deleted_users = [];
  const deleted_orgs = [];
  const skipped = [];

  // ---- 1) 用户 ----
  for (let i = 0; i < uids.length; i++) {
    const id = uids[i];
    if (id === auth.id) {
      skipped.push({ id: id, name: '（你自己）', reason: '不能删除自己的账号' });
      continue;
    }
    let u = null;
    try { u = $app.findRecordById('users', id); } catch (err) { u = null; }
    if (!u) { skipped.push({ id: id, name: id, reason: '账号不存在' }); continue; }
    if (u.get('platform_admin')) {
      skipped.push({ id: id, name: String(u.get('email') || id), reason: '平台管理员账号受保护' });
      continue;
    }
    const mail = String(u.get('email') || id);
    try {
      // access_requests.user_id 是 cascadeDelete:true，申请记录会跟着一起没
      $app.delete(u);
      deleted_users.push({ id: id, name: mail });
    } catch (err) {
      skipped.push({ id: id, name: mail, reason: '删除失败：' + String(err) });
    }
  }

  // ---- 2) 公司 ----
  for (let i = 0; i < oids.length; i++) {
    const id = oids[i];
    let o = null;
    try { o = $app.findRecordById('organizations', id); } catch (err) { o = null; }
    if (!o) { skipped.push({ id: id, name: id, reason: '公司不存在' }); continue; }

    const name = String(o.get('name') || id);

    // 付费过的永不删 —— 即使 force 也不行，这是财务底线
    let paid = 0;
    try {
      paid = $app.findRecordsByFilter('orders', 'org_id = "' + id + '" && status = "paid"', '', 50, 0).length;
    } catch (err) { paid = 0; }
    let subs = 0;
    try {
      subs = $app.findRecordsByFilter('subscriptions', 'org_id = "' + id + '"', '', 50, 0).length;
    } catch (err) { subs = 0; }
    if (paid > 0 || subs > 0) {
      skipped.push({ id: id, name: name, reason: '有付费/订阅记录，拒绝删除' });
      continue;
    }

    // 有成员：默认拦下；force 才删，且先把成员踢回「无公司」状态
    let mrows = [];
    try { mrows = $app.findRecordsByFilter('users', 'org_id = "' + id + '"', '-created', 500, 0); } catch (err) { mrows = []; }
    if (mrows.length && !data.force) {
      skipped.push({ id: id, name: name, reason: '有 ' + mrows.length + ' 名成员，需勾选「强制删除」' });
      continue;
    }
    for (let k = 0; k < mrows.length; k++) {
      try {
        mrows[k].set('org_id', '');
        mrows[k].set('role', '');
        $app.save(mrows[k]);
      } catch (err) { /* 踢人失败不阻断删公司，成员会带悬空 org_id，下次体检时归为孤儿账号 */ }
    }

    // 级联删除：sync_units / org_data / invitations / orders / subscriptions / access_requests
    // 全部是 cascadeDelete:true，这里删公司一行就够
    try {
      $app.delete(o);
      deleted_orgs.push({ id: id, name: name, kicked: mrows.length });
    } catch (err) {
      skipped.push({ id: id, name: name, reason: '删除失败：' + String(err) });
    }
  }

  return e.json(200, {
    ok: true,
    deleted_users: deleted_users,
    deleted_orgs: deleted_orgs,
    skipped: skipped
  });
});
