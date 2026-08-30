/**
 * 备份上传：打包好的 pb_data → 腾讯云 COS，并清理 30 天前的旧备份。
 *
 * 部署位置：/opt/pocketbase/upload_backup.js
 * 依赖：复用 /opt/cossign/node_modules 里已装好的 cos-nodejs-sdk-v5，不用再装东西。
 * 密钥：从 /etc/cossign.env 读入（由 backup.sh 注入），不写在代码里。
 *
 * ⚠️ 两个 COS 踩坑（2026-08-30 连续实测）：
 *   1. 多 AZ 桶不接受单 AZ 存储类型（STANDARD / STANDARD_IA），要用 MAZ_* 前缀的。
 *      这里做两级兜底：先 MAZ_STANDARD_IA，被拒就退回桶默认类型。
 *   2. **不要用 headBucket 做前置检查**。它是「桶级」操作，而 CAM 的数据面策略
 *      （QcloudCOSDataReadOnly 等）只授权「对象级」（资源后缀 /*），headBucket 会直接 403。
 *      曾因此把「能上传」误判成「桶不可访问」。这里改成探查失败只告警、不阻断。
 */
const fs = require('fs');
const path = require('path');
const COS = require('/opt/cossign/node_modules/cos-nodejs-sdk-v5');

const { COS_SECRET_ID, COS_SECRET_KEY, COS_BUCKET, COS_REGION } = process.env;

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error('用法: node upload_backup.js <备份文件>');
  process.exit(1);
}
const missing = ['COS_SECRET_ID', 'COS_SECRET_KEY', 'COS_BUCKET', 'COS_REGION']
  .filter(k => !process.env[k]);
if (missing.length) {
  console.error('缺少环境变量: ' + missing.join(', ') + '（请确认 /etc/cossign.env 存在且已注入）');
  process.exit(1);
}

const cos = new COS({ SecretId: COS_SECRET_ID, SecretKey: COS_SECRET_KEY });
const key = 'backups/' + path.basename(file);
const sizeMB = (fs.statSync(file).size / 1024 / 1024).toFixed(2);

console.log('桶: ' + COS_BUCKET + '  地域: ' + COS_REGION);

// 探桶只是锦上添花：CAM 数据面策略通常不给桶级权限，403 很正常，绝不能因此阻断上传
cos.headBucket({ Bucket: COS_BUCKET, Region: COS_REGION }, (berr, bdata) => {
  if (berr) {
    console.warn('（探桶跳过，不影响上传：' + (berr.message || berr) + '）');
  } else {
    const h = (bdata && bdata.headers) || {};
    const az = h['x-cos-bucket-az-type'] || h['X-Cos-Bucket-Az-Type'] || '未知';
    console.log('桶可用区类型: ' + az + '（MAZ = 多可用区）');
  }
  upload(['MAZ_STANDARD_IA', null]);
});

/* 依次尝试存储类型，第一个成功即止 */
function upload(classes) {
  if (!classes.length) {
    console.error('所有存储类型都上传失败');
    process.exit(1);
  }
  const sc = classes.shift();
  const opt = { Bucket: COS_BUCKET, Region: COS_REGION, Key: key, Body: fs.createReadStream(file) };
  if (sc) opt.StorageClass = sc;
  cos.putObject(opt, (err) => {
    if (err) {
      const msg = String(err.message || err);
      // 多 AZ 桶拒绝单 AZ 类型 / 该地域不支持该类型 → 换下一个
      if (msg.indexOf('availability zone') > -1 || msg.indexOf('StorageClass') > -1 || err.statusCode === 400) {
        console.warn('  ' + (sc || '默认类型') + ' 被拒绝（' + msg.slice(0, 80) + '），换一种重试');
        return upload(classes);
      }
      console.error('上传失败: ' + msg);
      if (err.requestId) console.error('  RequestId: ' + err.requestId);
      process.exit(1);
    }
    console.log('已上传 cos://' + COS_BUCKET + '/' + key + '  (' + sizeMB + ' MB)'
      + (sc ? ('  存储类型=' + sc) : '  存储类型=桶默认'));
    cleanupOld();
  });
}

/* 保留最近 30 天，更早的删掉。清理失败不影响本次备份成功。 */
function cleanupOld() {
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  cos.getBucket({ Bucket: COS_BUCKET, Region: COS_REGION, Prefix: 'backups/' }, (e, d) => {
    if (e || !d || !Array.isArray(d.Contents) || !d.Contents.length) return;
    const old = d.Contents.filter(o => new Date(o.LastModified).getTime() < cutoff);
    if (!old.length) return;
    cos.deleteMultipleObject({
      Bucket: COS_BUCKET, Region: COS_REGION, Objects: old.map(o => ({ Key: o.Key }))
    }, (e2) => {
      console.log(e2 ? ('清理旧备份失败: ' + (e2.message || e2)) : ('已清理 ' + old.length + ' 份 30 天前的旧备份'));
    });
  });
}
