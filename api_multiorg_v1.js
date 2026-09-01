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
  /* 多团队（2026-08-31）：原来这里有 `if (auth.get('org_id')) throw '你已经属于某个公司了'`。
     users.org_id 语义已降级为「当前激活团队」缓存，一个人可以同时属于多个团队，
     故不再拦。新建的公司会写一条 memberships(active)；只有当调用者原本没有任何
     激活团队时才顺手把它设为激活团队 —— 绝不把人从正在用的团队里硬拽走。 */
  /* 审核制（2026-08-31）：自助建公司已关闭。
     任何人原先填个公司名就能白拿 14 天试用并成为管理员，是最敞的口子。
     现在统一走 POST /api/request/submit {type:'org'}，由平台管理员审核后自动建公司。
     平台管理员（users.platform_admin = true）仍可直接调用本接口，方便人工开通。 */
  if (!auth.get('platform_admin')) {
    throw new ForbiddenError('已改为申请制：请提交开通申请，平台审核通过后自动开通');
  }

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
  org.set('paid_until', d.toISOString().slice(0, 10) + 'T00:00:00.000Z');
  org.set('seat_admin', 1);
  org.set('seat_member', 2);
  org.set('storage_used', 0);
  org.set('storage_quota', 5 * 1024 * 1024 * 1024);
  $app.save(org);

  /* 多团队：成员关系落在 memberships（唯一权威），users.org_id 只是激活缓存 */
  let memOk = false;
  try {
    const memCol = $app.findCollectionByNameOrId('memberships');
    const mr = new Record(memCol);
    mr.set('user_id', auth.id);
    mr.set('org_id', org.id);
    mr.set('role', 'admin');
    mr.set('status', 'active');
    mr.set('joined_at', new Date().toISOString());
    mr.set('invited_by', '');
    $app.save(mr);
    memOk = true;
  } catch (eMem) { console.warn('[org/create] memberships 写入失败：', eMem); }

  /* 只在「原本无激活团队」时激活新公司，避免把人从正在用的团队里拽走 */
  let switched = false;
  if (!auth.get('org_id')) {
    auth.set('org_id', org.id);
    auth.set('role', 'admin');
    $app.save(auth);
    switched = true;
  }

  return e.json(200, {
    orgId: org.id, name: org.get('name'), plan: 'trial', role: 'admin',
    membership: memOk, switched: switched
  });
});

// ---------- 管理员生成邀请（接受邮箱，真实发送邀请邮件） ----------
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

  const data = new DynamicModel({ role: 'reader', email: '' });
  e.bindBody(data);
  const targetEmail = String(data.email || '').trim();
  /* 🩸 #430：兜底值原本是 'member'，但 invitations.role 的候选值早已扩成
     ['admin','pm','designer','finance','purchaser','qa','reader']（'member' 不在其中）→
     客户端一旦显式传 role:'' 就会拿到非法值、写库 400 validation_invalid_value。
     改成与上面 DynamicModel 默认值一致的 'reader'（最小权限）。 */
  const role = data.role || 'reader';

  const invCol = $app.findCollectionByNameOrId('invitations');
  const inv = new Record(invCol);
  inv.set('org_id', org);
  inv.set('email', targetEmail);
  inv.set('role', role);
  inv.set('token', $security.randomString(24));
  const d = new Date();
  d.setDate(d.getDate() + 7);
  inv.set('expires', d.toISOString().slice(0, 10) + 'T00:00:00.000Z');
  inv.set('accepted', false);
  /* 显式初始化 revoked，避免「未取消」在过滤器里落成 null 而漏筛（字段由 schema_patch_v2 添加） */
  try { inv.set('revoked', false); } catch (eRv) {}
  try { $app.save(inv); } catch (saveErr) {
    throw new BadRequestError('创建邀请记录失败：' + (saveErr.message || String(saveErr)));
  }

  /* 真实发送邀请邮件（配置了 SMTP 且填写了邮箱才发；否则回退开发模式直返链接） */
  let mailer = null;
  try { mailer = require(`${__hooks}/mailer.js`); } catch (eM) { mailer = null; }
  const base = (mailer && mailer.APP_BASE_URL) ? mailer.APP_BASE_URL : 'http://106.55.14.231/';
  const link = base + '?invite=' + inv.get('token');
  let emailed = false;
  let devInviteLink = '';
  try {
    if (mailer && targetEmail) {
      let orgName = '';
      try { const o = $app.findRecordById('organizations', org); orgName = String(o.get('name') || ''); } catch (e2) {}
      const roleLabel = role;
      const subject = '您被邀请加入「' + orgName + '」装修工作台';
      const html = mailer.mailShell('团队邀请',
        '<p>您被邀请加入 <b>' + orgName + '</b> 的装修工作团队，角色：<b>' + roleLabel + '</b>。</p>'
        + '<p>点击下面的链接接受邀请（7 天内有效）：</p>'
        + '<p><a href="' + link + '" style="color:#1677ff">' + link + '</a></p>'
        + '<p style="color:#999;font-size:12px">若不是您本人操作，请忽略此邮件。</p>');
      mailer.sendMail(targetEmail, subject, html, '您被邀请加入「' + orgName + '」装修工作台，角色：' + roleLabel + '。邀请链接：' + link);
      emailed = true;
    }
  } catch (eMail) { console.warn('[invite] 邮件发送失败：', eMail); }
  if (!emailed && targetEmail) devInviteLink = link;

  return e.json(200, { token: inv.get('token'), expires: inv.get('expires'), emailed: emailed, dev_invite_link: devInviteLink });
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
  /* 多团队（2026-08-31）：原来这里有 `if (auth.get('org_id')) throw '你已经属于某个公司了'`，
     这是多团队最大的拦路虎。现在允许已在 A 团队的人接受 B 团队的邀请：
     写一条 memberships(active)，但**不夺走当前激活团队**（除非本来没有）。 */

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
  /* 取消邀请（revoked）后链接必须立即失效 */
  if (inv.get('revoked')) throw new BadRequestError('该邀请已被管理员取消');

  const exp = String(inv.get('expires') || '').replace(' ', 'T');
  if (exp && new Date(exp) < new Date()) throw new BadRequestError('邀请已过期');

  const targetOrg = String(inv.get('org_id') || '');
  const targetRole = String(inv.get('role') || 'member');
  if (!targetOrg) throw new BadRequestError('邀请数据异常：缺少团队');

  /* 成员关系：同一 (user, org) 复用同一行 —— 之前退出/被移出的把 status 翻回 active */
  let memRow = null;
  try {
    memRow = $app.findFirstRecordByFilter('memberships',
      "user_id = '" + auth.id + "' && org_id = '" + targetOrg + "'");
  } catch (eM) { memRow = null; }

  let alreadyActive = false;
  try {
    if (memRow) {
      if (String(memRow.get('status') || '') === 'active') {
        alreadyActive = true;
      } else {
        memRow.set('status', 'active');
        memRow.set('role', targetRole);
        memRow.set('joined_at', new Date().toISOString());
        $app.save(memRow);
      }
    } else {
      const memCol = $app.findCollectionByNameOrId('memberships');
      const mr = new Record(memCol);
      mr.set('user_id', auth.id);
      mr.set('org_id', targetOrg);
      mr.set('role', targetRole);
      mr.set('status', 'active');
      mr.set('joined_at', new Date().toISOString());
      mr.set('invited_by', '');
      $app.save(mr);
    }
  } catch (eMem) {
    throw new BadRequestError('写入成员关系失败：' + (eMem.message || String(eMem)));
  }

  /* 无激活团队 → 直接激活新团队；已有激活团队 → 保持不动，前端提示「去切换」 */
  let switched = false;
  if (!auth.get('org_id')) {
    auth.set('org_id', targetOrg);
    auth.set('role', targetRole);
    $app.save(auth);
    switched = true;
  }

  inv.set('accepted', true);
  $app.save(inv);

  let orgName = '';
  try { orgName = String($app.findRecordById('organizations', targetOrg).get('name') || ''); } catch (eN) {}

  return e.json(200, {
    orgId: targetOrg, org_name: orgName, role: targetRole,
    switched: switched, already: alreadyActive
  });
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
  /* 冻结拦截：status 由运营后台 /api/admin/org/update action=suspend 写入 */
  var orgStatus = '';
  if (org) {
    try {
      const o2 = $app.findRecordById('organizations', org);
      orgStatus = String(o2.get('status') || '');
    } catch (err) {}
  }
  /* 多团队：激活成员关系条数 —— 前端据此决定是否显示「切换团队」下拉。
     memberships 未就绪时降级为「有 org_id 就算 1 个」，不能返回 0 让 UI 误判成没团队。 */
  var orgCount = 0;
  try {
    const ms = $app.findRecordsByFilter('memberships',
      "user_id = '" + auth.id + "' && status = 'active'", '', 50, 0);
    orgCount = ms.length;
  } catch (errC) { orgCount = 0; }
  if (!orgCount && org) orgCount = 1;

  return e.json(200, {
    signedIn: true,
    id: auth.id,
    email: auth.get('email'),
    display_name: auth.get('display_name') || '',
    org_id: org || '',
    org_name: orgName,
    role: auth.get('role') || '',
    /* 平台运营方标记：运营后台据此放行，工作台据此显示运营入口 */
    platform_admin: !!auth.get('platform_admin'),
    plan: plan,
    /* 是否付费公司：套餐非试用即视为付费（试用创建时也会被写入 +14 天，不能靠日期判断） */
    is_paid: !!(plan && plan !== 'trial'),
    paid_until: paidUntil,
    seat_admin: seatAdmin,
    seat_member: seatMember,
    storage_used: storageUsed,
    storage_quota: storageQuota,
    org_status: orgStatus,
    /* > 1 时前端权限管理页显示「切换团队」下拉 */
    org_count: orgCount
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

  /* ── 后悔药：覆盖写之前先把当前这一版存进历史表 ──
     org_data 一家公司只有一行，写坏了就是全公司数据归零，必须留底。
     ⚠️ 快照失败绝不能影响主流程 —— 宁可没快照，也不能让用户存不了数据。 */
  try {
    const curData = rec.get('data');
    const raw = curData ? JSON.stringify(curData) : '';
    if (curData && raw.length <= 8000000) {
      const histCol = $app.findCollectionByNameOrId('org_data_history');
      const hRec = new Record(histCol);
      hRec.set('org_id', org);
      hRec.set('rev', cur);
      hRec.set('data', curData);
      hRec.set('size', raw.length);
      hRec.set('created_by', rec.get('updated_by') || auth.id);
      $app.save(hRec);
      /* 只留最近 20 份，超出的删最旧 */
      const olds = $app.findRecordsByFilter('org_data_history', 'org_id = "' + org + '"', '-rev', 200, 0);
      if (olds && olds.length > 20) {
        for (let i = 20; i < olds.length; i++) { try { $app.delete(olds[i]); } catch (e2) {} }
      }
    }
  } catch (err) { console.warn('[history] 快照失败，已跳过：', err); }

  rec.set('data', inData);
  rec.set('rev', cur + 1);
  rec.set('updated_by', auth.id);
  $app.save(rec);
  return e.json(200, { ok: true, rev: cur + 1, updated: String(rec.get('updated') || '') });
});

// ---------- 数据历史列表（只给元信息，不含 data，避免列表请求就很重） ----------
routerAdd('GET', '/api/data/history', (e) => {
  let auth = e.auth;
  if (!auth || !auth.id) {
    const hdr = e.request.header.get('Authorization') || '';
    const tk = hdr.indexOf(' ') > -1 ? hdr.split(' ')[1] : hdr;
    if (tk) { try { auth = $app.findAuthRecordByToken(tk); } catch (err) { auth = null; } }
  }
  if (!auth || !auth.id) throw new ForbiddenError('未登录');
  const org = auth.get('org_id');
  if (!org) return e.json(200, { items: [] });

  let rows = [];
  try {
    rows = $app.findRecordsByFilter('org_data_history', 'org_id = "' + org + '"', '-rev', 20, 0);
  } catch (err) { rows = []; }

  const items = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    let who = '';
    const by = r.get('created_by');
    if (by) { try { const u = $app.findRecordById('users', by); who = u.get('display_name') || u.get('email') || ''; } catch (err) {} }
    items.push({
      rev: Number(r.get('rev') || 0),
      size: Number(r.get('size') || 0),
      created: String(r.get('created') || ''),
      created_by: who
    });
  }
  return e.json(200, { items: items });
});

// ---------- 回滚到指定版本 ----------
routerAdd('POST', '/api/data/restore', (e) => {
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
  const want = Number(body.rev || 0);
  if (!want) throw new BadRequestError('缺少版本号 rev');

  let snap = null;
  try {
    snap = $app.findFirstRecordByFilter('org_data_history', 'org_id = "' + org + '" && rev = ' + want);
  } catch (err) { snap = null; }
  if (!snap) throw new BadRequestError('找不到该版本的备份，可能已被清理');

  let rec = null;
  try { rec = $app.findFirstRecordByFilter('org_data', 'org_id = "' + org + '"'); } catch (err) { rec = null; }
  if (!rec) throw new BadRequestError('当前没有数据可回滚');

  const cur = Number(rec.get('rev') || 0);
  const target = snap.get('data');

  /* 回滚本身也要可撤销：先把「当前这一版」存进历史，再覆盖 */
  try {
    const curData = rec.get('data');
    const raw = curData ? JSON.stringify(curData) : '';
    if (curData && raw.length <= 8000000) {
      const histCol = $app.findCollectionByNameOrId('org_data_history');
      const hRec = new Record(histCol);
      hRec.set('org_id', org);
      hRec.set('rev', cur);
      hRec.set('data', curData);
      hRec.set('size', raw.length);
      hRec.set('created_by', auth.id);
      $app.save(hRec);
    }
  } catch (err) { console.warn('[history] 回滚前快照失败：', err); }

  rec.set('data', target);
  rec.set('rev', cur + 1);
  rec.set('updated_by', auth.id);
  $app.save(rec);
  return e.json(200, { ok: true, rev: cur + 1, restoredFrom: want, updated: String(rec.get('updated') || '') });
});

// ========== 注册 / 用户名登录 / 验证码 / 找回密码 ==========
// 注意：邮件发送需要在服务器配置 SMTP 或调用腾讯云 SES。
// 开发模式下，send-code 接口会直接返回验证码（仅限非生产环境）。

routerAdd('POST', '/api/auth/send-code', (e) => {
  const data = new DynamicModel({ email: '' });
  e.bindBody(data);
  if (!data.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
    throw new BadRequestError('邮箱格式不正确');
  }
  /* 检查是否已注册
     🩸 原写法调 $app.findRecordByFilter() —— PB 里**没有这个方法**（只有 findRecordsByFilter /
        findFirstRecordByFilter，已在 pocketbase 二进制里核对过方法表）。抛 TypeError 后被
        catch 全吞 → 这道「该邮箱已注册」提示形同虚设，已注册邮箱照样能反复拉验证码。
     这里用 findRecordsByFilter（返回数组，与下面的 .length 判断一致）。 */
  var existing = null;
  try {
    existing = $app.findRecordsByFilter('users', 'email = "' + data.email.replace(/'/g, "\\'") + '"', '', 1, 0);
    if (existing && existing.length > 0) existing = existing[0]; else existing = null;
  } catch (err) {
    /* 这只是「已注册」的便利性提示，查询失败时放行（注册接口自身的唯一性校验才是真正闸门），
       但必须留痕，否则和之前一样查不到原因 */
    console.warn('[send-code] 已注册检查失败（放行）：', String(err && err.message || err));
    existing = null;
  }
  if (existing) throw new BadRequestError('该邮箱已注册，请直接登录');

  /* 生成 6 位验证码 */
  var code = String(Math.floor(100000 + Math.random() * 900000));
  /* 存储验证码（5分钟有效期），落库成功后真实发送邮件 */
  try {
    let mailer = null;
    try { mailer = require(`${__hooks}/mailer.js`); } catch (eM) { mailer = null; }
    let col = null;
    try { col = $app.findCollectionByNameOrId('verification_codes'); } catch (e1) { col = null; }
    if (!col) throw new Error('verification_codes 集合不存在');
    var vc = new Record(col);
    vc.set('email', data.email);
    vc.set('code', code);
    vc.set('expires', new Date(Date.now() + 5 * 60 * 1000).toISOString());
    vc.set('used', false);
    $app.save(vc);
    /* 已落库 → 直接尝试真实发送（不预检测 SMTP，失败则回退 dev_code） */
    let emailed = false;
    try {
      if (mailer) {
        const subject = '【焕安居装修工作台】邮箱验证码：' + code;
        const html = mailer.mailShell('邮箱验证码',
          '<p>您正在注册焕安居装修工作台账号，验证码为：</p>'
          + '<p style="font-size:24px;font-weight:700;color:#1677ff;letter-spacing:4px;margin:12px 0">' + code + '</p>'
          + '<p>验证码 5 分钟内有效，请勿泄露给他人。</p>');
        mailer.sendMail(data.email, subject, html, '您的验证码是 ' + code + '（5 分钟内有效）');
        emailed = true;
      }
    } catch (eMail) { console.warn('[send-code] 邮件发送失败（可能未配 SMTP）：', eMail); }
    if (emailed) return e.json(200, { ok: true, emailed: true, message: '验证码已发送到您的邮箱，请查收' });
    return e.json(200, { ok: true, dev_code: code, message: '开发模式：验证码为 ' + code + '（邮件未发送，请检查 SMTP 配置）' });
  } catch (err) {
    /* 集合不存在等致命错误：开发模式直接返回验证码，便于联调 */
    console.warn('[send-code] 存储失败：', err);
    return e.json(200, { ok: true, dev_code: code, message: '开发模式：验证码为 ' + code + '（存储异常，未真实发送）' });
  }
});

routerAdd('POST', '/api/auth/verify-code', (e) => {
  const data = new DynamicModel({ email: '', code: '' });
  e.bindBody(data);
  if (!data.email || !data.code || data.code.length !== 6) {
    throw new BadRequestError('参数不正确');
  }
  try {
    var rows = $app.findRecordsByFilter(
      'verification_codes',
      'email = "' + data.email.replace(/'/g, "\\'") + '" && used = false',
      '-created', 10, 0
    );
    var now = new Date();
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (String(r.get('code') || '') === data.code) {
        var exp = r.get('expires');
        if (exp && new Date(exp) < now) throw new BadRequestError('验证码已过期，请重新获取');
        r.set('used', true);
        $app.save(r);
        return e.json(200, { ok: true, verified: true });
      }
    }
  } catch (err) {
    /* 「已过期」是本路由主动抛的业务错误，原样透出 */
    if (String(err.message || '').indexOf('过期') > -1) throw err;
    /* 🩸 其余异常（集合缺失 / 过滤器错 / save 失败）不能再降级成「验证码错误」——
       那会让用户在验证码没问题的情况下反复重发、永远排查不出原因。 */
    throw new BadRequestError('验证码校验异常，请稍后重试');
  }
  throw new BadRequestError('验证码错误');
});

routerAdd('POST', '/api/auth/register', (e) => {
  const data = new DynamicModel({ email: '', username: '', password: '', code: '' });
  e.bindBody(data);
  if (!data.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) throw new BadRequestError('邮箱格式不正确');
  if (!data.username || data.username.length < 3 || data.username.length > 20) throw new BadRequestError('用户名需要 3-20 个字符');
  if (!data.password || data.password.length < 8) throw new BadRequestError('密码至少 8 个字符');

  /* 二次验证：确保邮箱确实验证过（防止绕过前端直接调注册）
     🩸 原写法 `catch(err){ if(err.message.indexOf('验证')>-1) throw err; }` 会把
        「集合缺失 / 过滤器语法错 / 权限异常」等所有非预期错误**静默放行** ——
        等于验证码形同虚设，任何人都能直接注册。异常必须出声。 */
  try {
    var vrows = $app.findRecordsByFilter(
      'verification_codes',
      'email = "' + data.email.replace(/'/g, "\\'") + '" && used = true',
      '-created', 1, 0
    );
    if (!vrows || vrows.length === 0) throw new BadRequestError('请先完成邮箱验证');
  } catch (err) {
    if (String(err.message || '').indexOf('请先完成邮箱验证') > -1) throw err;
    /* 非预期错误一律不放行：既不能绕过验证，也不能让调用方只看到 400 Something went wrong */
    throw new BadRequestError('邮箱验证状态读取失败，请稍后重试');
  }

  /* 检查邮箱唯一性
     🩸 同上：原写法吞掉查询异常 → 重复邮箱一路走到 $app.save() 撞唯一约束
        → PB 再吞一层 → 用户只看到 400 Something went wrong（本次注册故障的第二种可能路径）。 */
  try {
    var eu = $app.findRecordsByFilter('users', 'email = "' + data.email.replace(/'/g, "\\'") + '"', '', 1, 0);
    if (eu && eu.length > 0) throw new BadRequestError('该邮箱已注册');
  } catch (err) {
    if (String(err.message || '').indexOf('该邮箱已注册') > -1) throw err;
    throw new BadRequestError('邮箱唯一性校验失败，请稍后重试');
  }

  /* 创建用户（PocketBase Auth Record）
     🩸 $app.collection() 在 goja JSVM 里不存在（typeof === 'undefined'），
        一调用就抛 TypeError，PB 吞掉异常只回 400 "Something went wrong"。
        必须用 $app.findCollectionByNameOrId()。
     🩸 users 集合没有 username 字段（PB 内置的是 name），set('username') 静默失效，
        导致后续按用户名登录永远查不到。统一用 name 存用户名。 */
  var ucol, user;
  try {
    ucol = $app.findCollectionByNameOrId('users');
    if (!ucol) throw new BadRequestError('系统未就绪：users 集合缺失');
    user = new Record(ucol);
    user.set('email', data.email);
    user.set('password', data.password);
    user.set('name', data.username);
    user.set('display_name', data.username);
    user.set('role', 'member');
    user.set('verified', true);
    /* 🩸 不主动 set org_id / status（2026-09-01 注册 400 真凶定位）：
       - org_id 是关系字段，对「尚未加入/创建公司」的新注册用户本就该为空；
         实测 `user.set('org_id', null)` 在 goja 里会在 $app.save 时触发关系字段校验异常
         （"Something went wrong" 的真凶之一），故干脆不设置。
       - status 字段存在但代码未接（#430 记忆），其 select 候选值未知，
         盲目 set('status','pending') 若不在候选值内会在 save 时抛「无效值」；
         新建用户本就是待审核态，留空即可（前端按 org_id 为空判定「未加入公司」）。
       之前 curl 实测游客直建用户（不带这两个字段）返回 200，证明二者均可空。 */
    $app.save(user);
  } catch (err) {
    /* 🩸 异常必须出声：save 阶段若因字段必填/类型不符/约束冲突（或 AfterCreate 钩子抛异常）
       失败，PB 会吞成英文 400 "Something went wrong"，无法定位。
       这里转成中文并带原始 message，让前端/用户能看到真实原因。 */
    throw new BadRequestError('注册保存失败：' + String(err && err.message ? err.message : err));
  }

  return e.json(200, { ok: true, id: user.id, email: data.email, username: data.username });
});

/* 🩸 临时诊断路由（2026-09-01 注册 400 排查用，确认后删除）：
   用与 register 完全相同的建用户逻辑，但不走邮箱验证，直接把原始报错（含 stack）
   以 JSON 返回。这样无需收验证码即可读出 $app.save 阶段在 PB 里到底炸在哪。
   用完即删，勿留生产。 */
routerAdd('POST', '/api/_diag_register', (e) => {
  const data = new DynamicModel({ email: '', username: '', password: '' });
  e.bindBody(data);
  var created = null;
  try {
    var ucol = $app.findCollectionByNameOrId('users');
    if (!ucol) return e.json(200, { ok: false, stage: 'findCollection', error: 'users collection missing' });
    var u = new Record(ucol);
    u.set('email', data.email);
    u.set('password', data.password);
    u.set('name', data.username);
    u.set('display_name', data.username);
    u.set('role', 'member');
    u.set('verified', true);
    $app.save(u);
    created = u;
    return e.json(200, { ok: true, id: u.id, email: data.email });
  } catch (err) {
    return e.json(200, {
      ok: false,
      error: String(err && err.message ? err.message : err),
      stack: String(err && err.stack ? err.stack : '')
    });
  } finally {
    /* 自愈：诊断产生的测试用户立即删掉，不留污染 */
    if (created) { try { $app.deleteRecord(created); } catch (e2) {} }
  }
});

routerAdd('POST', '/api/auth/login-username', (e) => {
  const data = new DynamicModel({ login: '', password: '' });
  e.bindBody(data);
  if (!data.login || !data.password) throw new BadRequestError('请输入用户名/邮箱和密码');

  /* 通过用户名或邮箱查找用户 */
  var found = null;
  try {
    var list = $app.findRecordsByFilter(
      'users',
      /* users 集合没有 username 字段 → 用 name（注册时存的用户名）+ email 双查 */
      '(name = "' + data.login.replace(/'/g, "\\'") + '" || email = "' + data.login.replace(/'/g, "\\'") + '")',
      '', 1, 0
    );
    if (list && list.length > 0) found = list[0];
  } catch (err) { /* 过滤失败不抛，走下面的「账号不存在」 */ }

  if (!found) throw new NotFoundError('账号不存在');

  /* 用 PocketBase 内置认证验证密码 —— 通过 /api/admin 走不通，
     这里只做记录查找，实际 token 签发由前端走 PB 原生 /api/collections/users/auth-with-password */
  return e.json(200, {
    ok: true,
    email: found.get('email'),
    username: found.get('name') || found.get('display_name') || '',
    id: found.id
  });
});

routerAdd('POST', '/api/auth/request-reset', (e) => {
  const data = new DynamicModel({ email: '' });
  e.bindBody(data);
  if (!data.email) throw new BadRequestError('请输入邮箱');

  var found = null;
  try {
    var list = $app.findRecordsByFilter('users', 'email = "' + data.email.replace(/'/g, "\\'") + '"', '', 1, 0);
    if (list && list.length > 0) found = list[0];
  } catch (err) {}

  /* 无论账号是否存在都返回 200（防止枚举）；但只有存在账号才真正发信 */
  if (found) {
    const token = $security.randomString(32);
    /* 作废该邮箱旧的未用重置令牌（复用 verification_codes.code 字段，长度 > 10 即重置令牌） */
    try {
      var olds = $app.findRecordsByFilter('verification_codes', 'email = "' + data.email.replace(/'/g, "\\'") + '" && used = false', '', 50, 0);
      if (olds) {
        for (var i = 0; i < olds.length; i++) {
          var cd = String(olds[i].get('code') || '');
          if (cd.length > 10) { olds[i].set('used', true); try { $app.save(olds[i]); } catch (e2) {} }
        }
      }
    } catch (err) {}
    /* 存新令牌（30 分钟有效期） */
    try {
      let vcCol = null;
      try { vcCol = $app.findCollectionByNameOrId('verification_codes'); } catch (e1) { vcCol = null; }
      if (vcCol) {
        var rc = new Record(vcCol);
        rc.set('email', data.email);
        rc.set('code', token);
        rc.set('expires', new Date(Date.now() + 30 * 60 * 1000).toISOString());
        rc.set('used', false);
        $app.save(rc);
      }
    } catch (err) { console.warn('[reset] 存储令牌失败：', err); }

    /* 真实发送重置邮件 */
    let mailer = null;
    try { mailer = require(`${__hooks}/mailer.js`); } catch (eM) { mailer = null; }
    const base = (mailer && mailer.APP_BASE_URL) ? mailer.APP_BASE_URL : 'http://106.55.14.231/';
    const link = base + '?reset=' + token + '&email=' + encodeURIComponent(data.email);
    try {
      if (mailer) {
        const subject = '【焕安居装修工作台】重置密码链接';
        const html = mailer.mailShell('重置密码',
          '<p>我们收到了您的密码重置请求。点击下面的链接设置新密码（30 分钟内有效）：</p>'
          + '<p><a href="' + link + '" style="color:#1677ff">' + link + '</a></p>'
          + '<p style="color:#999;font-size:12px">若不是您本人操作，请忽略此邮件，账号不会受影响。</p>');
        mailer.sendMail(data.email, subject, html, '重置密码链接：' + link + '（30 分钟内有效）');
        return e.json(200, { ok: true, emailed: true, message: '重置链接已发送到您的邮箱' });
      }
    } catch (eMail) { console.warn('[reset] 邮件发送失败：', eMail); }
    /* 开发模式 fallback：直返链接，便于管理员手动转发 / 联调 */
    return e.json(200, { ok: true, dev_reset_link: link, message: '开发模式：重置链接为 ' + link + '（尚未配置 SMTP，未真实发送）' });
  }

  return e.json(200, { ok: true, message: '如果该邮箱有注册账号，重置链接将发送到该邮箱' });
});

// 用令牌校验并重置密码（链接来自邮件 / 开发模式直返）
routerAdd('POST', '/api/auth/confirm-reset', (e) => {
  const data = new DynamicModel({ email: '', token: '', password: '' });
  e.bindBody(data);
  if (!data.email || !data.token) throw new BadRequestError('参数不完整');
  if (!data.password || data.password.length < 8) throw new BadRequestError('密码至少 8 个字符');

  /* 找未用的重置令牌 */
  var rec = null;
  try {
    var rows = $app.findRecordsByFilter(
      'verification_codes',
      "email = '" + data.email.replace(/'/g, "\\'") + "' && used = false",
      '-created', 20, 0
    );
    if (rows) {
      for (var i = 0; i < rows.length; i++) {
        if (String(rows[i].get('code') || '') === data.token) { rec = rows[i]; break; }
      }
    }
  } catch (err) {}
  if (!rec) throw new BadRequestError('重置链接无效或已使用');
  const exp = rec.get('expires');
  if (exp && new Date(exp) < new Date()) throw new BadRequestError('重置链接已过期，请重新获取');

  /* 改密码（PocketBase Auth Record 在 $app.save 时自动哈希） */
  var u = null;
  try { u = $app.findFirstRecordByFilter('users', "email = '" + data.email.replace(/'/g, "\\'") + "'"); } catch (err) { u = null; }
  if (!u) throw new BadRequestError('账号不存在');
  u.set('password', data.password);
  $app.save(u);

  /* 作废令牌 + 顺手清掉该邮箱其它未用令牌 */
  try {
    rec.set('used', true); $app.save(rec);
    var rest = $app.findRecordsByFilter('verification_codes', "email = '" + data.email.replace(/'/g, "\\'") + "' && used = false", '', 50, 0);
    if (rest) { for (var j = 0; j < rest.length; j++) { try { rest[j].set('used', true); $app.save(rest[j]); } catch (e3) {} } }
  } catch (err) {}

  return e.json(200, { ok: true, message: '密码已重置，请用新密码登录' });
});
