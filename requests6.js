/// <reference path="../pb_data/types.d.ts" />
// 审核制：申请队列表 + 平台管理员标记
// 设计要点：
//   1) access_requests 所有规则设为 null —— 客户端一律不能直接读写，
//      必须走 api_review.pb.js 的路由。这样审核权限判断集中在 JS 里，可控可测。
//   2) users.platform_admin 标记平台运营方（唯一能审核「开通公司」申请的人），
//      由运营在 PocketBase 后台手动勾选，不开放任何自助提权路径。
migrate((app) => {
  const users = app.findCollectionByNameOrId('users');
  const orgs = app.findCollectionByNameOrId('organizations');

  // ---------- 1. users 加 platform_admin ----------
  const probe = new Collection({
    name: '__probe_req_fields',
    type: 'base',
    fields: [
      { name: 'platform_admin', type: 'bool' }
    ]
  });
  const paField = probe.fields.getByName('platform_admin');
  if (paField) users.fields.add(paField);
  app.save(users);

  // ---------- 2. access_requests（开通公司 / 加入公司 两类申请） ----------
  const reqs = new Collection({
    name: 'access_requests',
    type: 'base',
    // 全部 null：客户端只能经由路由操作，杜绝绕过审核直接改状态
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { name: 'type', type: 'select', maxSelect: 1, values: ['org', 'join'] },
      { name: 'user_id', type: 'relation', required: false, maxSelect: 1, collectionId: users.id, cascadeDelete: true },
      { name: 'org_id', type: 'relation', required: false, maxSelect: 1, collectionId: orgs.id, cascadeDelete: true },
      { name: 'role', type: 'select', maxSelect: 1, values: ['admin', 'member'] },
      { name: 'org_name', type: 'text', max: 100 },
      { name: 'contact_name', type: 'text', max: 50 },
      { name: 'contact_phone', type: 'text', max: 30 },
      { name: 'message', type: 'text', max: 300 },
      { name: 'status', type: 'select', maxSelect: 1, values: ['pending', 'approved', 'rejected'] },
      { name: 'review_note', type: 'text', max: 300 },
      { name: 'reviewed_by', type: 'relation', required: false, maxSelect: 1, collectionId: users.id, cascadeDelete: false },
      { name: 'reviewed_at', type: 'date' },
      { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
      { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true }
    ]
  });
  app.save(reqs);

  // 常用查询：(status, type) 与 (org_id, status)
  reqs.indexes = JSON.stringify([
    'CREATE INDEX idx_req_status_type ON access_requests (status, type)',
    'CREATE INDEX idx_req_org_status ON access_requests (org_id, status)'
  ]);
  app.save(reqs);
}, (app) => {
  // 回滚：先删表，再摘 users 字段
  try { app.delete(app.findCollectionByNameOrId('access_requests')); } catch (e) {}

  const users = app.findCollectionByNameOrId('users');
  const f = users.fields.getByName('platform_admin');
  if (f) users.fields.removeById(f.id);
  app.save(users);
});
