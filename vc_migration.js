/// <reference path="../pb_data/types.d.ts" />
// 邮箱验证码 / 密码重置令牌 / 邀请令牌 的持久化集合
// 设计要点：
//   1) 三条 auth 路由（send-code / request-reset / invite）都把临时凭证落此表，
//      后续 verify-code / confirm-reset / accept-invite 再查此表校验，实现"先发后验"。
//   2) 规则全部 null —— 客户端不得直接读写此表，只能经由自定义路由（$app 提权操作）。
//   3) code 字段复用：注册/邀请存 6 位短码，重置令牌存 32 位长串（路由按长度区分）。
migrate((app) => {
  const vc = new Collection({
    name: 'verification_codes',
    type: 'base',
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { name: 'email', type: 'text', required: true, max: 191 },
      { name: 'code', type: 'text', required: true, max: 64 },
      { name: 'expires', type: 'date', required: false },
      { name: 'used', type: 'bool', required: false },
      { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
      { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true }
    ]
  });
  app.save(vc);

  // 常用查询：(email, used) 与 (email, used, code)
  vc.indexes = JSON.stringify([
    'CREATE INDEX idx_vc_email_used ON verification_codes (email, used)'
  ]);
  app.save(vc);
}, (app) => {
  try { app.delete(app.findCollectionByNameOrId('verification_codes')); } catch (e) {}
});
