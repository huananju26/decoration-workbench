#!/usr/bin/env bash
# 部署脚本本地 dry-run —— 在推上生产之前，先在本地把整条链路真跑一遍
#
# 用法：
#   bash dryrun_deploy.sh                 # 验证本地 deploy_server_v3.sh
#   bash dryrun_deploy.sh online          # 验证**线上**那份（推荐，验的就是用户将执行的版本）
#
# 做了什么：把 sudo 去掉、路径改到临时目录、systemctl 换成 no-op，然后真跑一遍。
# 能提前发现：URL 404、字节不符、cp 路径错、变量未展开、语法错误、自检块逻辑问题。
#
# ⚠️ 两个必须替换的 macOS/Linux 差异（不换就会假红，但服务器上其实没事）：
#   - `wc -c < file`：BSD/macOS 输出带前导空格，GNU/Linux 不带
#     （deploy_server_v3.sh 里已用 `| tr -d ' '` 两边通吃，本地脚本也照做）
#   - `stat -c%s`（Linux） vs `stat -f%z`（macOS）
# 探活地址也换成外网可达的，否则 127.0.0.1 在 dry-run 机器上没有 PB。
set -u

cd "$(dirname "$0")" || exit 1
B="https://huananju26.github.io/decoration-workbench"
MODE="${1:-local}"
OUT="/tmp/dryrun_out"
SRC="deploy_server_v3.sh"

if [ "$MODE" = "online" ]; then
  echo "拉取线上版本： $B/deploy_server_v3.sh"
  curl -sSL --max-time 60 -o /tmp/_dry_online.sh "$B/deploy_server_v3.sh" || { echo "❌ 拉取失败"; exit 1; }
  SRC="/tmp/_dry_online.sh"
  echo "  线上字节 = $(wc -c < /tmp/_dry_online.sh | tr -d ' ')"
fi

rm -rf "$OUT" && mkdir -p "$OUT/hooks" "$OUT/pub"

sed -e 's/sudo //g' \
    -e 's|/opt/pocketbase/pb_hooks|'"$OUT"'/hooks|g' \
    -e 's|/opt/pocketbase/pb_public|'"$OUT"'/pub|g' \
    -e 's|systemctl restart pocketbase|echo "[dryrun] skip systemctl restart"|g' \
    -e 's|systemctl is-active --quiet pocketbase|true|g' \
    -e 's|systemctl is-active pocketbase|echo active|g' \
    -e 's|stat -c%s|stat -f%z|g' \
    -e 's|http://127.0.0.1/api/health|'"$B"'/|g' \
    "$SRC" > /tmp/_dry_run.sh

if ! bash -n /tmp/_dry_run.sh 2>/tmp/_dry_syntax.err; then
  echo "❌ 脚本语法错误："; cat /tmp/_dry_syntax.err; exit 1
fi
echo "✓ 语法OK，开始 dry-run（$MODE 版）"
echo "  临时目录：$OUT"
echo ""

bash /tmp/_dry_run.sh
code=$?

echo ""
if [ "$code" = "0" ]; then
  echo "✅ dry-run 通过（exit 0）—— 脚本逻辑没问题，可放心推生产"
else
  echo "❌ dry-run 失败（exit $code）—— 修好再推生产"
fi

echo ""
echo "落地产物（供检查）："
ls -1 "$OUT/hooks" 2>/dev/null | sed 's/^/    hooks\//'
ls -1 "$OUT/pub"   2>/dev/null | sed 's/^/    pub\//'
exit $code
