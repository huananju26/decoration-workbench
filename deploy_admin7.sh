#!/usr/bin/env bash
# 焕安居装修工作台 · 只部署运营后台（admin7.html）
#
# ⛔⛔⛔ 已废弃 —— 请勿执行，运营后台固定入口是 deploy_admin.sh ⛔⛔⛔
#
#   curl -sSL -o /tmp/da.sh https://huananju26.github.io/decoration-workbench/deploy_admin.sh
#   sudo bash /tmp/da.sh
#
# 🚨 为什么必须拦死（安全问题，不是版本问题）：
#   本脚本会把后台写成 $PUB/**admin7.html**（新文件名）。
#   而 Caddy 的 basicauth 规则是照 **/admin.html** 这个路径配的 ——
#   换个名字就会让那条规则命中不到 → **运营后台直接裸奔**（含全量公司/用户数据、
#   审核通过与否、清理删除操作）。这是本项目的既有铁律：
#     「别再搞 admin6/admin7/admin8 之类的对外地址——换新名会让针对 /admin.html
#       的 Caddy 规则（basicauth / no-cache）全部失效、后台变相裸奔」
#   正确姿势：中转站用递增名绕缓存，落到服务器后**固定覆盖成 admin.html**。
#   deploy_admin.sh 就是这么做的。
#
# 本文件保留仅供考古。真的要用，先确认 Caddy 已为新地址补上 basicauth。
echo "⛔ deploy_admin7.sh 已废弃，请勿执行 —— 改用 deploy_admin.sh"
echo ""
echo "   curl -sSL -o /tmp/da.sh https://huananju26.github.io/decoration-workbench/deploy_admin.sh"
echo "   sudo bash /tmp/da.sh"
echo ""
echo "   🚨 原因：本脚本会把后台落成 admin7.html，而 Caddy 的 basicauth 是按"
echo "      /admin.html 配的 —— 换名即绕过 → 运营后台裸奔（详见脚本头部注释）。"
exit 1

# 用途：deploy_server_v3.sh 已跑过后，只修后台页面时用它，不用重启 PocketBase。
# 用法（在 106.55.14.231 上执行，需 sudo）：
#   curl -sSL -o /tmp/d7.sh https://huananju26.github.io/decoration-workbench/deploy_admin7.sh
#   sudo bash /tmp/d7.sh
#
# 本次修复（#421）：
#   「全部公司」页到期日日期框显示空白 —— <input type="date"> 只认 YYYY-MM-DD，
#    而 PocketBase 的 paid_until 是完整时间戳 "2026-09-30 00:00:00.000Z"，
#    直接塞进 value 会被判非法值 → 框里一片空白（看着像功能没生效）。
#   → 新增 dateOnly() 截取日期部分；无到期日时框内提示"未设置"。
set -e

BASE="https://huananju26.github.io/decoration-workbench"
PUB="/opt/pocketbase/pb_public"
EXP_admin=30667   # admin7.html

dl() { # url out expected
  local url="$1" out="$2" exp="$3" got
  curl -sSL --max-time 120 -o "$out" "$url"
  got=$(wc -c < "$out")
  if [ "$got" != "$exp" ]; then
    echo "  !! 字节不符 $(basename "$out"): 期望 $exp 实际 $got（gh-pages 可能未同步，15s 后重试）"
    sleep 15
    curl -sSL --max-time 120 -o "$out" "$url"
    got=$(wc -c < "$out")
    if [ "$got" != "$exp" ]; then
      echo "  !! 仍不符，中止。确认文件已上线：$url"
      exit 1
    fi
  fi
  echo "  ✓ $(basename "$out") = $got 字节"
}

echo "== [1/2] 下载运营后台 admin7.html =="
dl "$BASE/admin7.html" /tmp/admin7.html $EXP_admin

echo "== [2/2] 部署到 pb_public（不动钩子、不重启 PocketBase）=="
sudo cp /tmp/admin7.html "$PUB/admin7.html"
echo "  ✓ 运营后台已部署"

echo ""
echo "DONE ✅ 运营后台更新完成。"
echo "  访问（硬刷新 Ctrl/Cmd+Shift+R）：http://106.55.14.231/admin7.html"
echo ""
echo "  验证清单："
echo "  ✅ 「全部公司」页每行的到期日日期框应显示已有到期日（如 2026-09-14），不是空白"
echo "  ✅ 改日期 → 点「设到期日」→ 上方「到期」列的文字应同步更新"
echo "  ✅ 「清理」页底部有「允许删除付费公司」勾选框"
echo "  ✅ 「成员」页能列出全部注册成员"
