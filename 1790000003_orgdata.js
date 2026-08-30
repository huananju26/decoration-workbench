/// <reference path="../pb_data/types.d.ts" />
//
// 团队版 V1 数据层：整份 App 按「公司」存一行。
// 设计取舍见《C阶段》文档——V1 用乐观锁（rev）防覆盖，V2 再拆项目级粒度。
//
// 为什么不用「一行一个用户」：团队版的核心是一家人共享同一份业务数据，
// 按用户存会导致每个人看到自己的副本，协作无从谈起。
// 为什么不用全规范化 6 张表：需求未经验证前投入数周重写，做错方向的代价太高。
//
migrate((app) => {
  const orgId = app.findCollectionByNameOrId('organizations').id;
  const userId = app.findCollectionByNameOrId('users').id;

  const col = new Collection({
    name: 'org_data', type: 'base',
    listRule: 'org_id = @request.auth.org_id',
    viewRule: 'org_id = @request.auth.org_id',
    createRule: '@request.body.org_id = @request.auth.org_id',
    updateRule: 'org_id = @request.auth.org_id && (@request.body.org_id = "" || @request.body.org_id = @request.auth.org_id)',
    // 不允许删除：整家公司的业务数据只有这一行，删掉就是灭顶之灾
    deleteRule: null,
    fields: [
      { name: 'org_id', type: 'relation', required: true, maxSelect: 1, collectionId: orgId, cascadeDelete: true },
      // data 存整份 App JSON。照片剥离到 COS 后体积应在 500KB 内，20MB 是安全冗余
      { name: 'data', type: 'json', maxSize: 20000000 },
      // 乐观锁版本号：每次保存 +1，客户端提交时携带，不匹配即判冲突
      { name: 'rev', type: 'number', onlyInt: true, min: 0 },
      { name: 'updated_by', type: 'relation', maxSelect: 1, collectionId: userId, cascadeDelete: false },
      { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
      { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true }
    ],
    // 一个公司只能有一行，从数据库层面锁死（光靠 maxSelect:1 不保证唯一）
    indexes: ['CREATE UNIQUE INDEX `idx_org_data_org` ON `org_data` (`org_id`)']
  });
  app.save(col);
}, (app) => {
  try { app.delete(app.findCollectionByNameOrId('org_data')); } catch (e) {}
});
