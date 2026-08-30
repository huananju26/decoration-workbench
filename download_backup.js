/**
 * 从 COS 下载备份文件，供 restore.sh 使用。
 *
 * 部署位置：/opt/pocketbase/download_backup.js
 * 用法：node download_backup.js latest            → 下载最新的一份
 *       node download_backup.js pb_backup_xxx.tar.gz → 下载指定文件名
 *
 * 最后一行 stdout 输出下载到本地的路径，shell 用 $(... | tail -1) 捕获。
 * 其余信息一律走 stderr，避免污染这个路径输出。
 *
 * 说明：如果直接给了文件名（以 .tar.gz 结尾），跳过列目录直接下载 ——
 *       CAM 数据面策略可能不允许 list，但下载（对象级）一定可以。
 */
const fs = require('fs');
const path = require('path');
const COS = require('/opt/cossign/node_modules/cos-nodejs-sdk-v5');

const { COS_SECRET_ID, COS_SECRET_KEY, COS_BUCKET, COS_REGION } = process.env;
if (!COS_SECRET_ID || !COS_SECRET_KEY || !COS_BUCKET || !COS_REGION) {
  console.error('缺少 COS 环境变量，请确认 /etc/cossign.env 存在且已注入');
  process.exit(1);
}
const cos = new COS({ SecretId: COS_SECRET_ID, SecretKey: COS_SECRET_KEY });
const want = process.argv[2] || 'latest';

if (want !== 'latest' && want.slice(-7) === '.tar.gz') {
  const key = want.slice(0, 8) === 'backups/' ? want : ('backups/' + want);
  download(key, () => {
    console.error('（若要指定其它备份，文件名可从 /var/log/pb_backup.log 里查）');
    process.exit(1);
  });
} else {
  cos.getBucket({ Bucket: COS_BUCKET, Region: COS_REGION, Prefix: 'backups/' }, (e, d) => {
    if (e || !d || !Array.isArray(d.Contents) || !d.Contents.length) {
      console.error('列不出备份列表（' + ((e && e.message) || '空') + '）');
      console.error('可以显式指定文件名，例如：node download_backup.js pb_backup_20260830-162456.tar.gz');
      console.error('文件名可从 /var/log/pb_backup.log 里找到');
      process.exit(1);
    }
    const list = d.Contents.slice().sort((a, b) => new Date(b.LastModified) - new Date(a.LastModified));
    let pick = null;
    if (want === 'latest') pick = list[0];
    else pick = list.find(o => path.basename(o.Key) === want || o.Key === want);
    if (!pick) {
      console.error('找不到备份：' + want);
      console.error('可用的备份：');
      list.slice(0, 10).forEach(o => {
        console.error('  ' + path.basename(o.Key) + '   ' + o.LastModified + '   '
          + (o.Size / 1024 / 1024).toFixed(2) + ' MB');
      });
      process.exit(1);
    }
    console.error('可用备份共 ' + list.length + ' 份，本次取：' + path.basename(pick.Key)
      + '（' + new Date(pick.LastModified).toLocaleString() + '）');
    download(pick.Key);
  });
}

function download(key, onFail) {
  const out = '/tmp/' + path.basename(key);
  console.error('正在下载 cos://' + COS_BUCKET + '/' + key);
  cos.getObject(
    { Bucket: COS_BUCKET, Region: COS_REGION, Key: key, Output: fs.createWriteStream(out) },
    (err) => {
      if (err) {
        console.error('下载失败: ' + (err.message || err));
        if (onFail) return onFail();
        process.exit(1);
      }
      console.error('已下载到 ' + out);
      console.log(out);   /* ← 最后一行：路径，供 shell 捕获 */
    }
  );
}
