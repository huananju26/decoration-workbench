// 1790000008: 扩展 invitations.role select 值（从 ['admin','member'] → 7 种角色）
// 触发原因：前端 ROLE_OPTIONS 有 pm/designer/finance/purchaser/qa/reader/admin，后端只允许 admin/member → 邀请 designer 等 400

migrate((app) => {
  const collection = app.findCollectionByNameOrId('invitations');
  if (!collection) return;

  const field = collection.fields.getByName('role');
  if (field) {
    field.options.values = ['admin', 'pm', 'designer', 'finance', 'purchaser', 'qa', 'reader'];
    app.save(collection);
  }
}, (app) => {
  // 回滚
  const collection = app.findCollectionByNameOrId('invitations');
  if (!collection) return;
  const field = collection.fields.getByName('role');
  if (field) {
    field.options.values = ['admin', 'member'];
    app.save(collection);
  }
});
