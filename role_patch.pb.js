// 临时补丁：扩展 invitations.role 为 7 种角色值。
// 作用：运行时读出 role 字段真实结构，自动尝试正确写法并保存（不会让 PB 启动崩溃）。
// 用完验证邀请 designer 等可用后，可自行删除本文件（rm pb_hooks/role_patch.pb.js + restart）。
const PATCH_TOKEN = 'hjrp_9k2x';

routerAdd('GET', '/api/patch_role', (e) => {
  const tok = (e.request.header.get('X-Patch-Token') || '').toString().trim();
  if (tok !== PATCH_TOKEN) return e.json(403, { ok: false, err: 'forbidden' });
  try {
    const collection = $app.findCollectionByNameOrId('invitations');
    if (!collection) return e.json(500, { ok: false, step: 'find', err: 'no invitations collection' });
    const field = collection.fields.getByName('role');
    if (!field) return e.json(500, { ok: false, step: 'getByName', err: 'no role field' });

    const vals = ['admin', 'pm', 'designer', 'finance', 'purchaser', 'qa', 'reader'];
    const probe = {
      type: field.type,
      optsType: (typeof field.options),
      valsType: (typeof field.values),
      fieldKeys: Object.keys(field).slice(0, 40)
    };

    let method = '';
    try {
      if (Array.isArray(field.values)) {
        field.values = vals; method = 'field.values';
      } else if (field.options && typeof field.options === 'object') {
        field.options.values = vals; method = 'field.options.values';
      } else {
        field.options = { maxSelect: 1, values: vals }; method = 'rebuild field.options';
      }
      $app.save(collection);
      return e.json(200, { ok: true, method: method, probe: probe, newValues: vals });
    } catch (saveErr) {
      return e.json(500, { ok: false, step: 'save', method: method, err: String(saveErr), probe: probe });
    }
  } catch (err) {
    return e.json(500, { ok: false, step: 'top', err: String(err) });
  }
});
