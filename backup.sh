#!/bin/bash
# 装修工作台团队版 · 每日全量备份到腾讯云 COS
#
# 为什么停服务再拷：SQLite 开着 WAL，服务运行中直接 cp 可能拿到「半写」状态的文件，
# 这种备份恢复出来才发现是坏的，比没备份更糟。凌晨 3:30 停 2 秒，对这个业务没有影响。
#
# 部署：/opt/pocketbase/backup.sh（chmod +x）
# 定时：crontab -e 加一行  30 3 * * * /opt/pocketbase/backup.sh >> /var/log/pb_backup.log 2>&1
set -e

TS=$(date +%Y%m%d-%H%M%S)
WORK=/tmp/pb_backup_$TS
SRC=/opt/pocketbase/pb_data

# 1. 停服务，拿一致性快照
systemctl stop pocketbase
mkdir -p "$WORK"
cp -a "$SRC" "$WORK/pb_data"
systemctl start pocketbase

# 2. 打包（data.db 里多为 JSON，压缩比很高）
tar -czf "$WORK.tar.gz" -C /tmp "pb_backup_$TS"

# 3. 上传 COS（低频存储，30 天最小存储期，正好匹配保留策略）
set -a
[ -f /etc/cossign.env ] && . /etc/cossign.env
set +a
/usr/bin/node /opt/pocketbase/upload_backup.js "$WORK.tar.gz"

# 4. 清本地临时文件，只留 COS 上的
rm -rf "$WORK" "$WORK.tar.gz"
echo "$(date '+%F %T') 备份完成"
