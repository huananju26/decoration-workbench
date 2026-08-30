/// <reference path="../pb_data/types.d.ts" />
//
// 团队版 V2 数据层：把「一家公司一个整包 JSON」拆成「按单元存储」。
//
// 为什么必须拆（实测结论，见《多人同步能力评估报告》）：
//   V1 的 org_data 一家公司只有一行，任何一次保存都是整包覆盖 ——
//   两个人改不同项目也要二选一，冲突粒度是「整个公司」。
//   而且它撑不起实时：整包太大，没法做秒级增量推送。
//
// V2 的单元划分：
//   core            → App 里除 projects 之外的一切（人材档案/供应商/合同/发票/设置）
//   proj:<projectId> → 单个项目（含其 tasks/purchases/expense/diaries/processSteps）
//
// 引擎不关心 unit_key 的含义，以后想拆更细（如 proj:<id>:fin）不用改表也不用改引擎。
//
// ⚠️ org_data 表保留不动：既是 V1 的回滚保险，也是本次迁移的数据源。
//
migrate((app) => {
  const orgId = app.findCollectionByNameOrId('organizations').id;
  const userId = app.findCollectionByNameOrId('users').id;

  const col = new Collection({
    name: 'sync_units', type: 'base',
    // 隔离规则与业务表完全一致：只能看/改自己公司的
    listRule: 'org_id = @request.auth.org_id',
    viewRule: 'org_id = @request.auth.org_id',
    createRule: '@request.body.org_id = @request.auth.org_id',
    updateRule: 'org_id = @request.auth.org_id && (@request.body.org_id = "" || @request.body.org_id = @request.auth.org_id)',
    // 允许删除（项目删了要能把单元删掉），但只能删自己公司的
    deleteRule: 'org_id = @request.auth.org_id',
    fields: [
      { name: 'org_id', type: 'relation', required: true, maxSelect: 1, collectionId: orgId, cascadeDelete: true },
      // 单元标识：core / proj:<id> / 以后可能的 proj:<id>:fin
      { name: 'unit_key', type: 'text', required: true, max: 120 },
      // 该单元的数据。照片迁到 COS 后应远小于此，2MB 是单项目的安全冗余
      { name: 'data', type: 'json', maxSize: 2000000 },
      // 单元级乐观锁：每个单元独立计数，A 项目冲突不影响 B 项目
      { name: 'rev', type: 'number', onlyInt: true, min: 0 },
      // 内容哈希：客户端用来判断「这个单元我到底改没改」，避免无谓上传
      { name: 'hash', type: 'text', max: 64 },
      { name: 'updated_by', type: 'relation', maxSelect: 1, collectionId: userId, cascadeDelete: false },
      { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
      { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true }
    ],
    indexes: [
      // 一个公司里同一个 unit_key 只能有一行 —— 从数据库层面锁死
      'CREATE UNIQUE INDEX `idx_sync_units_org_key` ON `sync_units` (`org_id`, `unit_key`)',
      // list 接口只查 key/rev/updated，这个索引让它走覆盖索引
      'CREATE INDEX `idx_sync_units_org` ON `sync_units` (`org_id`)'
    ]
  });
  app.save(col);
}, (app) => {
  try { app.delete(app.findCollectionByNameOrId('sync_units')); } catch (e) {}
});
