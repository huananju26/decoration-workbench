#!/usr/bin/env bash
# 焕安居装修工作台 · 团队版 运营后台修复部署（#410/#411/#412/#414/#415/#416）
# 用法（在 106.55.14.231 上执行，需 sudo）：
#   curl -sSL -o /tmp/d3.sh https://huananju26.github.io/decoration-workbench/deploy_server_v3.sh
#   sudo bash /tmp/d3.sh
#
# 本脚本做的事：
#   1) 从 GitHub Pages 中转站拉 5 个后端钩子 + 前端 app16.html + 运营后台 admin6.html
#   2) 字节校验（不一致=gh-pages 未同步，自动重试一次）
#   3) 备份当前 pb_public/index.html（回退点）
#   4) 写入 5 个常驻钩子（含本次新增的 api_admin / api_cleanup）+ 重启 PB
#   5) 部署前端 app16.html → index.html、运营后台 admin6.html
#
# 本次重点修复：
#   - 运营后台成员页拉不到（/api/admin/members 钩子此前从未部署，本次补上）
#   - 改为试用套餐仍显示「付费」（api_admin 未部署导致前端拿到旧逻辑，本次补上）
#   - 全部公司页增加「设到期日」日期框 + 按钮（后端 set_expiry 动作）
#   - 清理页「允许删除付费公司」勾选（后端 purge_paid 受控覆盖财务底线）
#   - 影像资料筛选「节点验收」空结果（前端已修，随 app16.html 上线）
set -e

BASE="https://huananju26.github.io/decoration-workbench"
HOOKS="/opt/pocketbase/pb_hooks"
PUB="/opt/pocketbase/pb_public"

# ── 预期字节（与本地 gh-pages 推送一致，用于完整性校验）──
EXP_api_team=24377     # api_team_v1.js       → pb_hooks/api_team.pb.js
EXP_api_multiorg=33964 # api_multiorg_v1.js   → pb_hooks/api.pb.js
EXP_api_review=11800   # api_review_v2.js     → pb_hooks/api_review.pb.js
EXP_api_admin=9175     # api_admin_v1.js      → pb_hooks/api_admin.pb.js
EXP_api_cleanup=11121  # api_cleanup_v1.js    → pb_hooks/api_cleanup.pb.js
EXP_app=1366831        # app16.html           → pb_public/index.html
EXP_admin=30243        # admin6.html          → pb_public/admin6.html

dl() { # url out expected
  local url="$1" out="$2" exp="$3" got
  curl -sSL --max-time 120 -o "$out" "$url"
  got=$(wc -c < "$out")
  if [ "$got" != "$exp" ]; then
    echo "  !! 字节不符 $(basename "$out"): 期望 $exp 实际 $got（可能 gh-pages 未同步，15s 后重试）"
    sleep 15
    curl -sSL --max-time 120 -o "$out" "$url"
    got=$(wc -c < "$out")
    if [ "$got" != "$exp" ]; then
      echo "  !! 仍不符，中止。请确认文件已上线："
      echo "     $BASE/$(basename "$url")"
      exit 1
    fi
  fi
  echo "  ✓ $(basename "$out") = $got 字节"
}

echo "== [1/5] 下载后端钩子（GitHub Pages 中转）=="
dl "$BASE/api_team_v1.js"     /tmp/api_team.pb.js     $EXP_api_team
dl "$BASE/api_multiorg_v1.js" /tmp/api.pb.js          $EXP_api_multiorg
dl "$BASE/api_review_v2.js"   /tmp/api_review.pb.js   $EXP_api_review
dl "$BASE/api_admin_v1.js"    /tmp/api_admin.pb.js    $EXP_api_admin
dl "$BASE/api_cleanup_v1.js"  /tmp/api_cleanup.pb.js  $EXP_api_cleanup

echo "== [2/5] 下载前端 app16.html + 运营后台 admin6.html =="
dl "$BASE/app16.html" /tmp/app16.html $EXP_app
dl "$BASE/admin6.html" /tmp/admin6.html $EXP_admin

echo "== [3/5] 备份当前 index.html + 写入 5 个钩子 =="
if [ -f "$PUB/index.html" ]; then
  sudo cp "$PUB/index.html" "$PUB/index.html.bak.$(date +%Y%m%d%H%M)"
  echo "  ✓ 已备份旧 index.html → index.html.bak.$(date +%Y%m%d%H%M)"
fi
sudo cp /tmp/api_team.pb.js     "$HOOKS/api_team.pb.js"
sudo cp /tmp/api.pb.js          "$HOOKS/api.pb.js"
sudo cp /tmp/api_review.pb.js   "$HOOKS/api_review.pb.js"
sudo cp /tmp/api_admin.pb.js    "$HOOKS/api_admin.pb.js"
sudo cp /tmp/api_cleanup.pb.js  "$HOOKS/api_cleanup.pb.js"
echo "  ✓ 5 个钩子已写入 $HOOKS/"

echo "== [4/5] 重启 pocketbase（加载含 api_admin / api_cleanup 的钩子集）=="
sudo systemctl restart pocketbase
sleep 4
if ! sudo systemctl is-active --quiet pocketbase; then
  echo "  !! PB 未起来，排查：journalctl -u pocketbase -n 50"
  exit 1
fi
echo "  ✓ pocketbase 已启动（5 钩子常驻）"

echo "== [5/5] 部署前端 app16.html → index.html + 运营后台 admin6.html =="
sudo cp /tmp/app16.html "$PUB/index.html"
sudo cp /tmp/app16.html "$PUB/app16.html"
sudo cp /tmp/admin6.html "$PUB/admin6.html"
echo "  ✓ 前端已部署（index.html / app16.html）"
echo "  ✓ 运营后台已部署：http://106.55.14.231/admin6.html"

echo ""
echo "DONE ✅ 部署完成。"
echo "  浏览器硬刷新（Ctrl/Cmd+Shift+R）：http://106.55.14.231/"
echo "  运营后台：http://106.55.14.231/admin6.html"
echo "  回退方式：sudo cp $PUB/index.html.bak.* $PUB/index.html 后刷新"
echo "  验证成员页：运营后台「成员」页应列出所有成员"
echo "  验证设到期日：全部公司页每行「到期」列下新增日期框 + 设到期日按钮"
