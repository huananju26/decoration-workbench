/// <reference path="../pb_data/types.d.ts" />
//
// 数据后悔药：每次保存前把上一版挪进历史表，可回滚任意一版。
//
// 为什么必须有：org_data 是「一家公司一行」，一条 UPDATE 写坏就是全公司数据归零。
// 实测踩过一次（2026-08-30 同步跳过覆盖后反向推送，把云端抹成空）。
// 乐观锁只能防「两个人同时改」，防不了「改错了 / 程序 bug 写坏」。
//
// 成本：App 剥离照片后单份应在 500KB 内，20 份约 10MB，对 SQLite 无压力。
// 保护：单份超过 SNAPSHOT_MAX_BYTES（8MB）不快照，避免异常数据撑爆数据库。
//
migrate((app) => {
  const orgId = app.findCollectionByNameOrId('organizations').id;
  const userId = app.findCollectionByNameOrId('users').id;

  const col = new Collection({
    name: 'org_data_history', type: 'base',
    // 只读：客户端一律不能增删改，全部通过 /api/data/restore 等路由操作
    listRule: 'org_id = @request.auth.org_id',
    viewRule: 'org_id = @request.auth.org_id',
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { name: 'org_id', type: 'relation', required: true, maxSelect: 1, collectionId: orgId, cascadeDelete: true },
      { name: 'rev', type: 'number', onlyInt: true, min: 0 },
      { name: 'data', type: 'json', maxSize: 20000000 },
      { name: 'size', type: 'number', onlyInt: true, min: 0 },
      { name: 'created_by', type: 'relation', maxSelect: 1, collectionId: userId, cascadeDelete: false },
      { name: 'created', type: 'autodate', onCreate: true, onUpdate: false }
    ],
    // 按公司 + 版本号查历史、按公司清理旧版本，两个索引都要
    indexes: [
      'CREATE INDEX `idx_hist_org_rev` ON `org_data_history` (`org_id`, `rev`)',
      'CREATE INDEX `idx_hist_created` ON `org_data_history` (`org_id`, `created`)'
    ]
  });
  app.save(col);
}, (app) => {
  try { app.delete(app.findCollectionByNameOrId('org_data_history')); } catch (e) {}
});
