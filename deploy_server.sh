#!/usr/bin/env bash
# 焕安居装修工作台 - 团队版 服务器端部署脚本
# 用法（在 106.55.14.231 上执行）：
#   curl -sSL -o /tmp/d.sh https://huananju26.github.io/decoration-workbench/deploy_server.sh
#   sudo bash /tmp/d.sh
# 说明：开头会提示一次 sudo 密码，之后 cp 复用票据，不会逐行卡住。
set -e

BASE="https://huananju26.github.io/decoration-workbench"
HOOKS="/opt/pocketbase/pb_hooks"
PUB="/opt/pocketbase/pb_public"

echo "[1/5] 下载钩子 api_v6.js ..."
curl -sSL --max-time 60 -o /tmp/api_v6.js "$BASE/api_v6.js"
echo "[2/5] 下载 mailer.js ..."
curl -sSL --max-time 60 -o /tmp/mailer.js "$BASE/mailer.js"
echo "[3/5] 下载前端 app15.html ..."
curl -sSL --max-time 120 -o /tmp/app15.html "$BASE/app15.html"

echo "[4/5] 校验下载字节（预期 29875 / 2891 / 1336430）..."
wc -c /tmp/api_v6.js /tmp/mailer.js /tmp/app15.html

echo "[5/5] 写入钩子与前端并重启 pocketbase ..."
sudo cp /tmp/api_v6.js  "$HOOKS/api.pb.js"
sudo cp /tmp/mailer.js  "$HOOKS/mailer.js"
sudo cp /tmp/app15.html "$PUB/index.html"

echo "重启服务..."
sudo systemctl restart pocketbase
sleep 3
sudo systemctl status pocketbase --no-pager | head -6
echo "DONE ✅"
