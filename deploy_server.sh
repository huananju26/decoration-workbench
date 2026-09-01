#!/usr/bin/env bash
# 焕安居装修工作台 - 团队版 服务器端部署脚本
#
# ⛔⛔⛔ 已废弃 —— 请勿执行，现役脚本是 deploy_server_v3.sh ⛔⛔⛔
#
#   curl -sSL -o /tmp/d3.sh https://huananju26.github.io/decoration-workbench/deploy_server_v3.sh
#   sudo bash /tmp/d3.sh
#
# 为什么必须拦死（2026-09-01 全量枚举 $app.xxx 调用时发现）：
#   ① 本脚本部署的 api_v6.js，其注册路由在 **try/catch 之外** 写着
#        var user = new Record($app.collection('users') || {});
#      而 `$app.collection()` 在 PocketBase 的 goja JSVM 里**根本不存在**
#      （#429 注册 400 的真因，typeof === 'undefined'）。
#      正确写法是 $app.findCollectionByNameOrId('users')。
#      → 执行本脚本 = 注册功能当场全线 400。
#   ② 它还会把前端回退到 app15.html（1336430 字节），比现役 app23.html
#      落后 34944 字节，等于倒退数月的改动。
#   ③ 它只装 3 个文件，现役需要 6 个钩子；少装的 api_team / api_review /
#      api_admin / api_cleanup / schema_patch_v3 会**静默失效**（路由消失，
#      前端表现为各种功能点了没反应，不报错）。
#
# 本文件保留仅供考古。真的要用旧版，请先读完上面三条再手动去掉下面的 exit。
echo "⛔ deploy_server.sh 已废弃，请勿执行 —— 改用 deploy_server_v3.sh"
echo ""
echo "   curl -sSL -o /tmp/d3.sh https://huananju26.github.io/decoration-workbench/deploy_server_v3.sh"
echo "   sudo bash /tmp/d3.sh"
echo ""
echo "   原因（详见脚本头部注释）：本脚本部署的 api_v6.js 注册路由调用了"
echo "   goja JSVM 里不存在的 \$app.collection()，会把注册功能打成全线 400，"
echo "   并把前端回退到 app15.html（落后 34944 字节）。"
exit 1

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
