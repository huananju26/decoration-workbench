#!/usr/bin/env bash
# 焕安居装修工作台 · 团队版 —— 仅部署「锁死 users 游客注册」补丁（schema_patch_v4_lock_users.pb.js）
#
# 用途：堵住 PB 原生 POST /api/collections/users/records 游客直注册、绕过邮箱验证的漏洞。
#   该规则是集合 schema 的一部分，写入 pb_data 后**永久生效**，
#   即使以后删除本补丁文件 / 重新部署也不会回退（除非管理员在后台手动放开）。
#
# 为什么单独一个脚本：这个改动只动一个钩子文件 + 一次重启，
#   不必重跑整套 deploy_server_v3.sh（那会连前端 app23.html 一起覆盖）。
#
# 用法（在 106.55.14.231 上执行，需 sudo）：
#   curl -sSL -o /tmp/d4.sh https://huananju26.github.io/decoration-workbench/deploy_lock_users.sh
#   sudo bash /tmp/d4.sh
set -e

B="https://huananju26.github.io/decoration-workbench"
HOOKS="/opt/pocketbase/pb_hooks"
PATCH="schema_patch_v4_lock_users.pb.js"

echo "== [1] 下载补丁 $PATCH =="
sudo curl -sSL --max-time 120 -o "$HOOKS/$PATCH" "$B/$PATCH"
SZ=$(sudo stat -c%s "$HOOKS/$PATCH" 2>/dev/null || echo 0)
if [ "$SZ" -lt 500 ]; then
  echo "   !! 下载异常（仅 $SZ 字节），中止"; exit 1
fi
echo "   下载完成，大小：$SZ 字节"

echo "== [2] 重启 PocketBase（钩子目录变更需重启才能加载）=="
sudo systemctl restart pocketbase
sleep 3
if sudo systemctl is-active --quiet pocketbase; then
  echo "   PocketBase 已重启并运行"
else
  echo "   !! PocketBase 未运行，请检查：sudo systemctl status pocketbase"
fi

echo "== [3] 等待补丁 cron 生效（每分钟触发一次，最多等 75s）=="
for i in $(seq 1 15); do
  if sudo journalctl -u pocketbase -n 30 2>/dev/null | grep -q 'schema_patch_v4.*已锁死\|schema_patch_v4.*已是禁止态'; then
    echo "   补丁已生效（第 $i 次探测）"; break
  fi
  sleep 5
done

echo "== [4] 自检：游客直注册是否已被拦截 =="
RESP=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST http://127.0.0.1/api/collections/users/records \
  -H 'Content-Type: application/json' \
  -d '{"email":"lockcheck_'"$(date +%s)"'@test.com","password":"password123","passwordConfirm":"password123"}' 2>/dev/null || echo 000)
if [ "$RESP" = "200" ]; then
  echo "   !! 仍返回 200 —— 锁未生效，请查：sudo journalctl -u pocketbase -n 50 | grep schema_patch_v4"
elif [ "$RESP" = "000" ]; then
  echo "   ?? 本地探测连接失败（可能 health 尚未就绪），请稍后手动复测："
  echo "      curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1/api/collections/users/records -H 'Content-Type: application/json' -d '{\"email\":\"x@y.com\",\"password\":\"password123\",\"passwordConfirm\":\"password123\"}'"
else
  echo "   ✅ 游客直注册已被拦截（HTTP=$RESP，非 200）。邮箱验证前置关恢复有效。"
fi

echo ""
echo "== 完成 =="
echo "   正常注册路径仍走 /api/auth/register（发送验证码 → 验证 → 注册），不受影响。"
echo "   查看补丁日志：sudo journalctl -u pocketbase -n 50 | grep schema_patch_v4"
