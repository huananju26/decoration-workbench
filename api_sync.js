// ============================================================
// 团队版 V2 同步层：按单元（core / proj:<id>）存取，单元级乐观锁
//
// ⚠️ JSVM 铁律（踩过坑，见 C 阶段记录）：
//   1. 每个 routerAdd 回调运行在【独立的 JS 上下文】——
//      顶层 function / var / globalThis 在回调里统统拿不到（报 xxx is not defined）。
//      所以下面每个路由都【完全自包含】，重复的鉴权代码是有意为之，不要去"优化"掉。
//   2. 读 JSON body 用 e.requestInfo().body（DynamicModel 绑不了嵌套对象）。
//   3. 禁用记录钩子（onRecordCreateRequest 等）—— 会让创建请求返回 200 空响应且不落库。
//
// ⚠️ 安全铁律：unit_key 来自客户端，若直接拼进 filter 字符串，
//    形如  org_id="A" && unit_key="x" || org_id!=""  会被运算符优先级钻空子，
//    绕过公司隔离读到别家数据。所以每个入口都必须先过白名单正则。
// ============================================================

// ---------- GET /api/sync/list：只返回 key/rev/hash/updated（极小，可高频轮询） ----------
routerAdd('GET', '/api/sync/list', (e) => {
  let auth = e.auth;
  if (!auth || !auth.id) {
    const hdr = e.request.header.get('Authorization') || '';
    const tk = hdr.indexOf(' ') > -1 ? hdr.split(' ')[1] : hdr;
    if (tk) { try { auth = $app.findAuthRecordByToken(tk); } catch (err) { auth = null; } }
  }
  if (!auth || !auth.id) throw new ForbiddenError('未登录');
  const org = auth.get('org_id');
  if (!org) throw new BadRequestError('你还没有公司');

  const recs = $app.findRecordsByFilter('sync_units', 'org_id = "' + org + '"', 'unit_key', 5000, 0);
  const out = [];
  if (recs) {
    for (let i = 0; i < recs.length; i++) {
      out.push({
        key: String(recs[i].get('unit_key') || ''),
        rev: Number(recs[i].get('rev') || 0),
        hash: String(recs[i].get('hash') || ''),
        updated: String(recs[i].get('updated') || '')
      });
    }
  }
  return e.json(200, { units: out, count: out.length });
});

// ---------- POST /api/sync/get：按 key 取单元内容 ----------
routerAdd('POST', '/api/sync/get', (e) => {
  let auth = e.auth;
  if (!auth || !auth.id) {
    const hdr = e.request.header.get('Authorization') || '';
    const tk = hdr.indexOf(' ') > -1 ? hdr.split(' ')[1] : hdr;
    if (tk) { try { auth = $app.findAuthRecordByToken(tk); } catch (err) { auth = null; } }
  }
  if (!auth || !auth.id) throw new ForbiddenError('未登录');
  const org = auth.get('org_id');
  if (!org) throw new BadRequestError('你还没有公司');

  const info = e.requestInfo();
  const body = (info && info.body) ? info.body : {};
  const keys = body.keys || [];
  if (!Array.isArray(keys) || keys.length === 0) throw new BadRequestError('缺少 keys');
  if (keys.length > 500) throw new BadRequestError('一次取的单元过多');

  const safe = [];
  for (let i = 0; i < keys.length; i++) {
    const k = String(keys[i] || '');
    if (!/^[A-Za-z0-9_:.\-]{1,120}$/.test(k)) throw new BadRequestError('单元标识含非法字符');
    safe.push(k);
  }

  const cond = [];
  for (let i = 0; i < safe.length; i++) cond.push('unit_key = "' + safe[i] + '"');
  const recs = $app.findRecordsByFilter(
    'sync_units',
    'org_id = "' + org + '" && (' + cond.join(' || ') + ')',
    '', 5000, 0
  );

  /* ⚠️ JSON 字段在 JSVM 里 get() 出来可能是字符串、也可能是对象（版本相关）。
     不归一化的话客户端收到的 data 会是个字符串而不是对象，整个前端直接崩。 */
  const normJson = (v) => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch (err) { return v; } }
    return v;
  };

  const units = [];
  if (recs) {
    for (let i = 0; i < recs.length; i++) {
      units.push({
        key: String(recs[i].get('unit_key') || ''),
        rev: Number(recs[i].get('rev') || 0),
        hash: String(recs[i].get('hash') || ''),
        updated: String(recs[i].get('updated') || ''),
        data: normJson(recs[i].get('data'))
      });
    }
  }
  return e.json(200, { units: units });
});

// ---------- POST /api/sync/save：单元级乐观锁，只冲突的单元失败 ----------
routerAdd('POST', '/api/sync/save', (e) => {
  let auth = e.auth;
  if (!auth || !auth.id) {
    const hdr = e.request.header.get('Authorization') || '';
    const tk = hdr.indexOf(' ') > -1 ? hdr.split(' ')[1] : hdr;
    if (tk) { try { auth = $app.findAuthRecordByToken(tk); } catch (err) { auth = null; } }
  }
  if (!auth || !auth.id) throw new ForbiddenError('未登录');
  const org = auth.get('org_id');
  if (!org) throw new BadRequestError('你还没有公司');

  const info = e.requestInfo();
  const body = (info && info.body) ? info.body : {};
  const units = body.units || [];
  if (!Array.isArray(units) || units.length === 0) throw new BadRequestError('缺少 units');
  if (units.length > 200) throw new BadRequestError('一次保存的单元过多');

  const col = $app.findCollectionByNameOrId('sync_units');
  const saved = [];
  const conflicts = [];

  for (let i = 0; i < units.length; i++) {
    const u = units[i] || {};
    const key = String(u.key || '');
    if (!/^[A-Za-z0-9_:.\-]{1,120}$/.test(key)) throw new BadRequestError('单元标识含非法字符');

    let rec = null;
    try {
      rec = $app.findFirstRecordByFilter(
        'sync_units',
        'org_id = "' + org + '" && unit_key = "' + key + '"'
      );
    } catch (err) { rec = null; }

    /* 新建：不校验 rev。两个人各自新建不同项目 → key 不同 → 都成功，互不影响。
       这正是 V2 相比 V1 最大的收益：并发创建不再互相顶掉。 */
    if (!rec) {
      const nr = new Record(col);
      nr.set('org_id', org);
      nr.set('unit_key', key);
      nr.set('data', u.data);
      nr.set('hash', String(u.hash || ''));
      nr.set('rev', 1);
      nr.set('updated_by', auth.id);
      $app.save(nr);
      saved.push({ key: key, rev: 1, hash: String(u.hash || ''), updated: String(nr.get('updated') || '') });
      continue;
    }

    const cur = Number(rec.get('rev') || 0);
    const inRev = Number(u.rev || 0);
    if (u.force !== true && inRev !== cur) {
      let who = '同事';
      const by = rec.get('updated_by');
      if (by) {
        try {
          const uu = $app.findRecordById('users', by);
          who = uu.get('display_name') || uu.get('email') || '同事';
        } catch (err) {}
      }
      conflicts.push({
        key: key,
        serverRev: cur,
        yourRev: inRev,
        updated: String(rec.get('updated') || ''),
        updated_by: who
      });
      continue;
    }

    rec.set('data', u.data);
    rec.set('hash', String(u.hash || ''));
    rec.set('rev', cur + 1);
    rec.set('updated_by', auth.id);
    $app.save(rec);
    saved.push({ key: key, rev: cur + 1, hash: String(u.hash || ''), updated: String(rec.get('updated') || '') });
  }

  return e.json(200, { saved: saved, conflicts: conflicts });
});

// ---------- POST /api/sync/delete：删除单元（项目删除要能同步给同事） ----------
routerAdd('POST', '/api/sync/delete', (e) => {
  let auth = e.auth;
  if (!auth || !auth.id) {
    const hdr = e.request.header.get('Authorization') || '';
    const tk = hdr.indexOf(' ') > -1 ? hdr.split(' ')[1] : hdr;
    if (tk) { try { auth = $app.findAuthRecordByToken(tk); } catch (err) { auth = null; } }
  }
  if (!auth || !auth.id) throw new ForbiddenError('未登录');
  const org = auth.get('org_id');
  if (!org) throw new BadRequestError('你还没有公司');

  const info = e.requestInfo();
  const body = (info && info.body) ? info.body : {};
  const keys = body.keys || [];
  if (!Array.isArray(keys) || keys.length === 0) throw new BadRequestError('缺少 keys');
  if (keys.length > 500) throw new BadRequestError('一次删除的单元过多');

  const deleted = [];
  for (let i = 0; i < keys.length; i++) {
    const key = String(keys[i] || '');
    if (!/^[A-Za-z0-9_:.\-]{1,120}$/.test(key)) throw new BadRequestError('单元标识含非法字符');
    try {
      const rec = $app.findFirstRecordByFilter(
        'sync_units',
        'org_id = "' + org + '" && unit_key = "' + key + '"'
      );
      if (rec) { $app.delete(rec); deleted.push(key); }
    } catch (err) { /* 本来就不存在，跳过 */ }
  }
  return e.json(200, { deleted: deleted });
});

// ---------- POST /api/sync/migrate：把 V1 的整包 org_data 拆成单元（一次性） ----------
// 幂等：该公司已有单元数据就跳过，除非带 force。
// ⚠️ org_data 原表保留不动，作为回滚保险。
routerAdd('POST', '/api/sync/migrate', (e) => {
  let auth = e.auth;
  if (!auth || !auth.id) {
    const hdr = e.request.header.get('Authorization') || '';
    const tk = hdr.indexOf(' ') > -1 ? hdr.split(' ')[1] : hdr;
    if (tk) { try { auth = $app.findAuthRecordByToken(tk); } catch (err) { auth = null; } }
  }
  if (!auth || !auth.id) throw new ForbiddenError('未登录');
  const org = auth.get('org_id');
  if (!org) throw new BadRequestError('你还没有公司');

  const info = e.requestInfo();
  const body = (info && info.body) ? info.body : {};
  const force = body.force === true || body.force === 'true';

  let existing = [];
  try {
    existing = $app.findRecordsByFilter('sync_units', 'org_id = "' + org + '"', '', 1, 0);
  } catch (err) { existing = []; }
  if (existing && existing.length > 0 && !force) {
    return e.json(200, { migrated: false, reason: '该公司已有单元数据，跳过迁移（要重跑请带 force）' });
  }

  const col = $app.findCollectionByNameOrId('sync_units');

  /* 先把旧的单元清干净（force 重跑时用），避免残留孤儿 */
  if (force && existing && existing.length > 0) {
    const all = $app.findRecordsByFilter('sync_units', 'org_id = "' + org + '"', '', 5000, 0);
    if (all) { for (let i = 0; i < all.length; i++) { try { $app.delete(all[i]); } catch (err) {} } }
  }

  let blob = null;
  try {
    blob = $app.findFirstRecordByFilter('org_data', 'org_id = "' + org + '"');
  } catch (err) { blob = null; }

  if (!blob) return e.json(200, { migrated: false, reason: '没有 V1 整包数据，无需迁移' });

  /* ⚠️ JSON 字段在 JSVM 里 get() 出来可能是字符串。
     不归一化的话 app 是个字符串，下面的 for...in 会按字符遍历，
     结果是 core 被塞成一堆数字下标、projects 一个都拆不出来（踩过）。 */
  /* ⚠️⚠️ JSON 字段在 PocketBase 0.40 的 JSVM 里 get() 出来是【UTF-8 字节数组】
     （typeof=object、constructor=Array、内容是 [123,34,...] 这样的 ASCII 码）。
     直接 for...in 会按数字下标遍历，projects 一个都拿不到，
     而 e.json() 直接把它交给 Go marshal 反而是对的（所以 /api/data/load 一直没事）。
     这里要自己按 UTF-8 解码 —— 不能偷懒用 fromCharCode 逐个转，
     否则「张师傅」这种中文项目名会变成乱码。 */
  const appRaw = blob.get('data');
  const utf8Decode = (b) => {
    if (typeof b === 'string') return b;
    if (!b || typeof b.length !== 'number') return '';
    let s = '';
    for (let i = 0; i < b.length; i++) {
      const c = b[i];
      if (c < 0x80) { s += String.fromCharCode(c); }
      else if (c < 0xE0) { s += String.fromCharCode(((c & 0x1F) << 6) | (b[++i] & 0x3F)); }
      else if (c < 0xF0) { s += String.fromCharCode(((c & 0x0F) << 12) | ((b[++i] & 0x3F) << 6) | (b[++i] & 0x3F)); }
      else {
        const cp = ((c & 0x07) << 18) | ((b[++i] & 0x3F) << 12) | ((b[++i] & 0x3F) << 6) | (b[++i] & 0x3F);
        s += String.fromCodePoint(cp);
      }
    }
    return s;
  };
  let app = null;
  try { app = JSON.parse(utf8Decode(appRaw)); } catch (err) { app = null; }
  if (!app || typeof app !== 'object') app = {};
  const projects = Array.isArray(app.projects) ? app.projects : [];

  /* core = App 里除 projects 之外的一切 */
  const core = {};
  for (const k in app) {
    if (k === 'projects') continue;
    if (k.indexOf('__') === 0) continue;      /* __pendingPush 等同步水位线不上云 */
    core[k] = app[k];
  }

  const hashOf = (s) => {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(16);
  };

  const made = [];

  const coreRaw = JSON.stringify(core);
  const cr = new Record(col);
  cr.set('org_id', org);
  cr.set('unit_key', 'core');
  cr.set('data', core);
  cr.set('hash', hashOf(coreRaw));
  cr.set('rev', 1);
  cr.set('updated_by', auth.id);
  $app.save(cr);
  made.push({ key: 'core', size: coreRaw.length });

  for (let i = 0; i < projects.length; i++) {
    const p = projects[i];
    const pid = String(p && p.id ? p.id : '');
    if (!pid) continue;
    if (!/^[A-Za-z0-9_:.\-]{1,120}$/.test(pid)) continue;   /* 脏 id 跳过，避免写出非法 key */
    const raw = JSON.stringify(p);
    const pr = new Record(col);
    pr.set('org_id', org);
    pr.set('unit_key', 'proj:' + pid);
    pr.set('data', p);
    pr.set('hash', hashOf(raw));
    pr.set('rev', 1);
    pr.set('updated_by', auth.id);
    $app.save(pr);
    made.push({ key: 'proj:' + pid, size: raw.length });
  }

  return e.json(200, {
    migrated: true,
    sourceRev: Number(blob.get('rev') || 0),
    units: made.length,
    detail: made
  });
});
