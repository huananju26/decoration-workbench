// 临时补丁：扩展 invitations.role 为 7 种角色值。
// 注意：PB JSVM 顶层 function/var 在 routerAdd 回调里不可见（每路由独立上下文），
// 因此本文件全部逻辑内联在回调内，无任何外部 function 声明。
// 用完验证邀请 designer 等可用后，可自行删除本文件（rm pb_hooks/role_patch.pb.js + restart）。
routerAdd('GET', '/api/patch_role', (e) => {
  try {
    // —— token 校验（内联，防御式读取查询参数 tok）——
    let tok = '';
    try {
      const u = e.request.url;
      const q = (u && typeof u.query === 'function') ? u.query() : null;
      if (q) {
        if (typeof q.get === 'function') { const v = q.get('tok'); if (v) tok = String(v); }
        else if (q['tok']) tok = Array.isArray(q['tok']) ? String(q['tok'][0]) : String(q['tok']);
      }
    } catch (_) {}
    if (tok !== 'hjrp_9k2x') return e.json(403, { ok: false, err: 'forbidden' });

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
        field.values = vals;
        method = 'field.values';
      } else if (field.options && typeof field.options === 'object') {
        field.options.values = vals;
        method = 'field.options.values';
      } else {
        field.options = { maxSelect: 1, values: vals };
        method = 'rebuild field.options';
      }
      $app.save(collection);
      return e.json(200, { ok: true, method: method, probe: probe, newValues: vals });
    } catch (saveErr) {
      return e.json(500, { ok: false, step: 'save', method: method, err: String(saveErr), probe: probe });
    }
  } catch (err) {
    return e.json(500, { ok: false, step: 'top', err: String(err), stack: String((err && err.stack) || '') });
  }
});
