/**
 * 备份上传：打包好的 pb_data → 腾讯云 COS，并清理 30 天前的旧备份。
 *
 * 部署位置：/opt/pocketbase/upload_backup.js
 * 依赖：复用 /opt/cossign/node_modules 里已装好的 cos-nodejs-sdk-v5，不用再装东西。
 * 密钥：从 /etc/cossign.env 读入（由 backup.sh 注入），不写在代码里。
 *
 * 存储类型用低频（STANDARD_IA）：比标准存储便宜 40%，30 天最小存储期
 * 正好和「保留 30 天」的清理策略对齐，不会被多收提前删除的费用。
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
if (!COS_SECRET_ID || !COS_SECRET_KEY || !COS_BUCKET || !COS_REGION) {
  console.error('缺少 COS 环境变量，请确认 /etc/cossign.env 存在且已注入');
  process.exit(1);
}

const cos = new COS({ SecretId: COS_SECRET_ID, SecretKey: COS_SECRET_KEY });
const key = 'backups/' + path.basename(file);
const sizeMB = (fs.statSync(file).size / 1024 / 1024).toFixed(2);

cos.putObject({
  Bucket: COS_BUCKET,
  Region: COS_REGION,
  Key: key,
  Body: fs.createReadStream(file),
  StorageClass: 'STANDARD_IA'
}, (err) => {
  if (err) {
    console.error('上传失败:', err.message || err);
    process.exit(1);
  }
  console.log('已上传 cos://' + COS_BUCKET + '/' + key + '  (' + sizeMB + ' MB)');
  cleanupOld();
});

/* 保留最近 30 天，更早的删掉。清理失败不影响本次备份成功。 */
function cleanupOld() {
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  cos.getBucket({
    Bucket: COS_BUCKET,
    Region: COS_REGION,
    Prefix: 'backups/'
  }, (e, d) => {
    if (e || !d || !Array.isArray(d.Contents) || !d.Contents.length) return;
    const old = d.Contents.filter(o => new Date(o.LastModified).getTime() < cutoff);
    if (!old.length) return;
    cos.deleteMultipleObject({
      Bucket: COS_BUCKET,
      Region: COS_REGION,
      Objects: old.map(o => ({ Key: o.Key }))
    }, (e2) => {
      console.log(e2 ? ('清理旧备份失败: ' + e2.message) : ('已清理 ' + old.length + ' 份 30 天前的旧备份'));
    });
  });
}
