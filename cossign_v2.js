/**
 * COS 上传签名服务
 * 只干两件事：验证用户身份 → 签发直传 COS 的临时 URL。
 * 图片本身不经过这台服务器（4Mbps 带宽扛不住），浏览器直传对象存储。
 *
 * 环境变量在 /etc/cossign.env（权限 600，绝不进前端、绝不进 git）
 */
const http = require('http');
const COS = require('cos-nodejs-sdk-v5');

const {
  COS_SECRET_ID, COS_SECRET_KEY, COS_BUCKET, COS_REGION,
  PB_URL, PB_ADMIN_EMAIL, PB_ADMIN_PASSWORD
} = process.env;

const PORT = Number(process.env.PORT || 8091);
const SIGN_TTL = 300; // 预签名有效期（秒）
const PUBLIC_HOST = `https://${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com`;

const cos = new COS({ SecretId: COS_SECRET_ID, SecretKey: COS_SECRET_KEY });

// ---------- 小工具 ----------
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => {
      d += c;
      if (d.length > 100000) { req.destroy(); reject(new Error('body too large')); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(d || '{}')); } catch (e) { reject(e); }
    });
  });
}

// ---------- PocketBase 交互 ----------
async function userByToken(token) {
  const r = await fetch(`${PB_URL}/api/collections/users/auth-refresh`, {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json' }
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j.record || null;
}

let admToken = null;
let admTokenAt = 0;
const ADM_TOKEN_TTL = 10 * 60 * 1000; // 10 分钟，到期强制重登，避免长跑进程拿到过期 token

async function admAuth(force) {
  const now = Date.now();
  if (admToken && !force && (now - admTokenAt) < ADM_TOKEN_TTL) return admToken;
  const r = await fetch(`${PB_URL}/api/collections/_superusers/auth-with-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity: PB_ADMIN_EMAIL, password: PB_ADMIN_PASSWORD })
  });
  if (!r.ok) throw new Error('管理员登录失败');
  const j = await r.json();
  admToken = j.token;
  admTokenAt = Date.now();
  return admToken;
}

// 用超级管理员 token 访问 PB。
// 任何非 2xx（含 401/403 过期）都清空缓存、强制重登后重试一次，
// 彻底杜绝「缓存的 admToken 过期 → 公司信息读取失败 403」这类偶发故障。
async function admFetch(path, options) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const t = await admAuth(attempt > 0);
    const r = await fetch(PB_URL + path, { ...options, headers: { ...(options || {}).headers, Authorization: t } });
    if (r.ok) return r;
    admToken = null; admTokenAt = 0; // 非 2xx：强制下一轮重登
  }
  // 两次都失败：返回最后一次响应，交由调用方按 .ok 处理
  const t = await admAuth(true);
  return await fetch(PB_URL + path, { ...options, headers: { ...(options || {}).headers, Authorization: t } });
}

// ---------- 业务判断：这张图要不要留原图 ----------
// 依据《团队版SaaS方案-PocketBase路线.md》§11.4
function needOriginal(photoType) {
  if (photoType === 'contract' || photoType === 'receipt') return 'original_only';
  if (photoType === 'acceptance' || photoType === 'hidden') return 'both';
  return 'compressed';
}

function makeKey(orgId, ext, tag) {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const rand = Math.random().toString(36).slice(2, 12);
  return `org_${orgId}/${y}/${m}/${rand}${tag ? '-' + tag : ''}.${ext}`;
}

function presign(key, contentType) {
  return new Promise((resolve, reject) => {
    cos.getObjectUrl({
      Bucket: COS_BUCKET,
      Region: COS_REGION,
      Key: key,
      Method: 'PUT',
      Expires: SIGN_TTL,
      Sign: true,
      Headers: { 'content-type': contentType || 'application/octet-stream' }
    }, (err, data) => (err ? reject(err) : resolve(data.Url)));
  });
}

/* 桶是【私有】的（实测匿名 GET 返回 403 AccessDenied，这是对的 ——
   客户家里的照片不该公网可访问）。所以读取也必须走签名 URL。
   前端把 key 存进业务数据，渲染时批量换签名 URL 并缓存。 */
const READ_TTL = 1800; // 读取签名有效期（秒），前端按这个时间缓存
function presignGet(key, expires) {
  return new Promise((resolve, reject) => {
    cos.getObjectUrl({
      Bucket: COS_BUCKET,
      Region: COS_REGION,
      Key: key,
      Method: 'GET',
      Expires: expires || READ_TTL,
      Sign: true
    }, (err, data) => (err ? reject(err) : resolve(data.Url)));
  });
}

function cosDeleteObject(key) {
  return new Promise((resolve, reject) => {
    cos.deleteObject({ Bucket: COS_BUCKET, Region: COS_REGION, Key: key },
      (err, data) => (err ? reject(err) : resolve(data)));
  });
}

// ---------- HTTP ----------
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, { ok: true, bucket: COS_BUCKET, region: COS_REGION });
  }

  if (req.method === 'POST' && req.url === '/cos/sign') {
    try {
      const auth = req.headers.authorization || '';
      if (!auth) return send(res, 401, { error: '未登录' });

      const user = await userByToken(auth);
      if (!user) return send(res, 401, { error: '登录已失效，请重新登录' });

      const orgId = user.org_id;
      if (!orgId) return send(res, 403, { error: '你还没有加入公司' });

      const body = await readBody(req);
      const size = Number(body.size || 0);
      const photoType = String(body.photoType || 'progress');
      const contentType = String(body.contentType || 'image/webp');
      const ext = (String(body.filename || 'x.webp').split('.').pop() || 'webp').toLowerCase();

      // 配额检查
      const orgRes = await admFetch(`/api/collections/organizations/records/${orgId}`);
      if (!orgRes.ok) {
        console.error('[cossign] 读取公司信息失败 orgId=%s status=%s', orgId, orgRes.status);
        return send(res, 403, { error: '公司信息读取失败' });
      }
      const org = await orgRes.json();
      const used = Number(org.storage_used || 0);
      const quota = Number(org.storage_quota || 0);
      if (quota > 0 && used + size > quota) {
        return send(res, 403, {
          error: '存储空间已满，请升级套餐或删除旧照片',
          used, quota, need: size
        });
      }

      const mode = needOriginal(photoType);
      const result = { mode, uploads: {}, publicHost: PUBLIC_HOST };

      if (mode !== 'original_only') {
        const key = makeKey(orgId, 'webp');
        result.uploads.compressed = {
          key,
          url: await presign(key, contentType)
        };
      }
      if (mode !== 'compressed') {
        const key = makeKey(orgId, ext || 'jpg', 'orig');
        result.uploads.original = {
          key,
          url: await presign(key, body.originType || 'image/jpeg')
        };
      }
      return send(res, 200, result);
    } catch (e) {
      return send(res, 400, { error: String(e && e.message ? e.message : e) });
    }
  }

  // 上传完成后回写用量（客户端拿到 COS 成功响应后调用）
  if (req.method === 'POST' && req.url === '/cos/confirm') {
    try {
      const auth = req.headers.authorization || '';
      if (!auth) return send(res, 401, { error: '未登录' });
      const user = await userByToken(auth);
      if (!user || !user.org_id) return send(res, 401, { error: '未登录或没有公司' });

      const body = await readBody(req);
      const add = Number(body.size || 0);
      if (add <= 0) return send(res, 400, { error: 'size 无效' });

      const orgRes = await admFetch(`/api/collections/organizations/records/${user.org_id}`);
      const org = await orgRes.json();
      const used = Number(org.storage_used || 0) + add;

      const patch = await admFetch(`/api/collections/organizations/records/${user.org_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storage_used: used })
      });
      if (!patch.ok) return send(res, 400, { error: '用量回写失败' });

      return send(res, 200, { ok: true, storage_used: used });
    } catch (e) {
      return send(res, 400, { error: String(e && e.message ? e.message : e) });
    }
  }

  // ---------- 批量换取读取签名 URL（桶私有，渲染时必须走这里） ----------
  if (req.method === 'POST' && req.url === '/cos/url') {
    try {
      const auth = req.headers.authorization || '';
      if (!auth) return send(res, 401, { error: '未登录' });
      const user = await userByToken(auth);
      if (!user || !user.org_id) return send(res, 401, { error: '未登录或没有公司' });

      const body = await readBody(req);
      const keys = body.keys || [];
      if (!Array.isArray(keys) || keys.length === 0) return send(res, 400, { error: '缺少 keys' });
      if (keys.length > 200) return send(res, 400, { error: '一次取的 key 过多' });

      const orgId = user.org_id;
      const prefix = `org_${orgId}/`;
      const urls = {};
      const denied = [];
      for (const raw of keys) {
        const k = String(raw || '');
        /* ⚠️ 越权防护：只能换自己公司前缀下的 key，
           否则谁都能拿别人的照片（key 里带 orgId，必须校验） */
        if (!k || k.indexOf(prefix) !== 0) { denied.push(k); continue; }
        try { urls[k] = await presignGet(k); }
        catch (e) { denied.push(k); }
      }
      return send(res, 200, { urls, denied, ttl: READ_TTL });
    } catch (e) {
      return send(res, 400, { error: String(e && e.message ? e.message : e) });
    }
  }

  // ---------- 删除照片（回收存储空间，避免只删引用不删对象） ----------
  if (req.method === 'POST' && req.url === '/cos/delete') {
    try {
      const auth = req.headers.authorization || '';
      if (!auth) return send(res, 401, { error: '未登录' });
      const user = await userByToken(auth);
      if (!user || !user.org_id) return send(res, 401, { error: '未登录或没有公司' });

      const body = await readBody(req);
      const items = body.items || [];
      if (!Array.isArray(items) || items.length === 0) return send(res, 400, { error: '缺少 items' });
      if (items.length > 200) return send(res, 400, { error: '一次删除的数量过多' });

      const prefix = `org_${user.org_id}/`;
      const deleted = [];
      const denied = [];
      let freed = 0;
      for (const it of items) {
        const k = String((it && it.key) || '');
        if (!k || k.indexOf(prefix) !== 0) { denied.push(k); continue; }
        try {
          await cosDeleteObject(k);
          deleted.push(k);
          freed += Number(it.size || 0);
        } catch (e) { denied.push(k); }
      }

      /* 回写用量：只减不增，且不小于 0 */
      if (freed > 0) {
        try {
          const orgRes = await admFetch(`/api/collections/organizations/records/${user.org_id}`);
          const org = await orgRes.json();
          const used = Math.max(0, Number(org.storage_used || 0) - freed);
          await admFetch(`/api/collections/organizations/records/${user.org_id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ storage_used: used })
          });
          return send(res, 200, { ok: true, deleted, denied, storage_used: used });
        } catch (e) { /* 用量回写失败不影响删除结果 */ }
      }
      return send(res, 200, { ok: true, deleted, denied });
    } catch (e) {
      return send(res, 400, { error: String(e && e.message ? e.message : e) });
    }
  }

  return send(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`cos-sign listening on 127.0.0.1:${PORT}`);
});
