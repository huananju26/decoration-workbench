#!/bin/bash
# 装修工作台团队版 · 从 COS 备份恢复
#
# 用法：sudo /opt/pocketbase/restore.sh              → 恢复最新的一份
#       sudo /opt/pocketbase/restore.sh pb_backup_20260830-162456.tar.gz  → 恢复指定那份
#
# 设计要点：
#   1. 覆盖前先把当前数据留底到 /tmp/pb_before_restore_*，恢复错了还能退回去
#   2. 必须先停服务再替换，运行中换文件会让 PocketBase 的 WAL 状态错乱
#   3. 结尾打印回退命令，不用手打
set -e

PB=/opt/pocketbase
DATA=$PB/pb_data
WANT="${1:-latest}"

set -a
[ -f /etc/cossign.env ] && . /etc/cossign.env
set +a

echo "=== 1/5 下载备份 ==="
TARBALL=$(/usr/bin/node "$PB/download_backup.js" "$WANT" | tail -1)
if [ ! -f "$TARBALL" ]; then
  echo "下载失败，恢复中止（现有数据未做任何改动）"
  exit 1
fi

echo "=== 2/5 当前数据留底 ==="
SAFE=/tmp/pb_before_restore_$(date +%Y%m%d-%H%M%S)
cp -a "$DATA" "$SAFE"
echo "已留底到 $SAFE"

echo "=== 3/5 解压 ==="
WORK=/tmp/pb_restore_$$
rm -rf "$WORK"; mkdir -p "$WORK"
tar -xzf "$TARBALL" -C "$WORK"
if [ ! -d "$WORK/pb_data" ]; then
  echo "备份包结构不对（缺少 pb_data 目录），恢复中止"
  echo "现有数据未改动，留底副本在 $SAFE"
  exit 1
fi

echo "=== 4/5 停服务并替换 ==="
systemctl stop pocketbase
rm -rf "$DATA"
mv "$WORK/pb_data" "$DATA"
chown -R root:root "$DATA"

echo "=== 5/5 启动 ==="
systemctl start pocketbase
sleep 3
curl -s -o /dev/null -w "服务探活 HTTP %{http_code}\n" http://127.0.0.1/api/ping

echo ""
echo "恢复完成，请立刻打开页面核对数据。"
echo "如果恢复有误，执行下面这条回退到恢复前："
echo "  systemctl stop pocketbase && rm -rf $DATA && mv $SAFE $DATA && systemctl start pocketbase"
