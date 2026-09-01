#!/usr/bin/env bash
# 焕安居装修工作台 · 团队管理增强（#406/#407/#408）服务器端部署脚本
#
# ⛔⛔⛔ 已废弃 —— 请勿执行，现役脚本是 deploy_server_v3.sh ⛔⛔⛔
#
#   curl -sSL -o /tmp/d3.sh https://huananju26.github.io/decoration-workbench/deploy_server_v3.sh
#   sudo bash /tmp/d3.sh
#
# 为什么拦（2026-09-01 审查旧脚本时发现）：
#   ① 本脚本只装 4 个钩子（api_team / api / api_review / schema_patch_v2），
#      现役需要 6 个 —— 缺 api_admin、api_cleanup、schema_patch_v3 会**静默失效**：
#      路由直接消失，运营后台与清理功能点了没反应，且不报错，很难发现。
#   ② 前端写死 app10.html（EXP_app=1365104），比现役 app23.html（1371374）
#      落后 6270 字节，等于回退若干次迭代。
#   ③ EXP_api_multiorg=33964 与现文件 36976 不符 → 它自己会在下载步中止，
#      卡在半途（钩子已写入、前端没换）的半成品状态，比彻底失败更难收拾。
#
# 本文件保留仅供考古。真的要用，先读完上面三条再手动去掉下面的 exit。
echo "⛔ deploy_server_v2.sh 已废弃，请勿执行 —— 改用 deploy_server_v3.sh"
echo ""
echo "   curl -sSL -o /tmp/d3.sh https://huananju26.github.io/decoration-workbench/deploy_server_v3.sh"
echo "   sudo bash /tmp/d3.sh"
echo ""
echo "   原因（详见脚本头部注释）：本脚本只装 4 个钩子（现役需要 6 个，缺的会静默失效）、"
echo "   前端写死 app10.html（落后 6270 字节）、且字节校验已过期会在下载步卡成半成品。"
exit 1

# 用法（在 106.55.14.231 上执行，需 sudo）：
#   curl -sSL -o /tmp/d2.sh https://huananju26.github.io/decoration-workbench/deploy_server_v2.sh
#   sudo bash /tmp/d2.sh
#
# 本脚本做的事（先后端、再前端，与方案一致）：
#   1) 从 GitHub Pages 中转站拉 4 个钩子 + 前端 app10.html（新文件名已避开 CDN 缓存）
#   2) 字节校验（不一致=gh-pages 未同步，自动重试一次）
#   3) 备份当前 pb_public/index.html（回退点）
#   4) 写入 3 个常驻钩子 + 1 个一次性补丁钩子，重启 PB
#   5) 跑补丁：建 memberships 表 + invitations.revoked/revoked_at + 存量回填
#   6) 校验返回 ok:true 且 match:true（否则中止，保留补丁钩子供排查）
#   7) 删除补丁钩子、重启 PB、部署前端 app10.html → index.html
set -e

BASE="https://huananju26.github.io/decoration-workbench"
HOOKS="/opt/pocketbase/pb_hooks"
PUB="/opt/pocketbase/pb_public"
TOK="hjaj-patch-v2-20260831"

# ── 预期字节（与本地 gh-pages 推送一致，用于完整性校验）──
EXP_api_team=24377      # api_team_v1.js            → pb_hooks/api_team.pb.js
EXP_api_multiorg=33964  # api_multiorg_v1.js        → pb_hooks/api.pb.js
EXP_api_review=11800    # api_review_v2.js          → pb_hooks/api_review.pb.js
EXP_patch=9609          # schema_patch_v2b.js       → pb_hooks/schema_patch_v2.pb.js (临时)
EXP_app=1365104         # app10.html                → pb_public/index.html

dl() { # url out expected
  local url="$1" out="$2" exp="$3" got
  curl -sSL --max-time 90 -o "$out" "$url"
  got=$(wc -c < "$out")
  if [ "$got" != "$exp" ]; then
    echo "  !! 字节不符 $(basename "$out"): 期望 $exp 实际 $got（可能 gh-pages 未同步，15s 后重试）"
    sleep 15
    curl -sSL --max-time 90 -o "$out" "$url"
    got=$(wc -c < "$out")
    if [ "$got" != "$exp" ]; then
      echo "  !! 仍不符，中止。请确认文件已上线："
      echo "     $BASE/$(basename "$url")"
      exit 1
    fi
  fi
  echo "  ✓ $(basename "$out") = $got 字节"
}

echo "== [1/7] 下载后端钩子（GitHub Pages 中转）=="
dl "$BASE/api_team_v1.js"      /tmp/api_team.pb.js        $EXP_api_team
dl "$BASE/api_multiorg_v1.js"  /tmp/api.pb.js             $EXP_api_multiorg
dl "$BASE/api_review_v2.js"    /tmp/api_review.pb.js      $EXP_api_review
dl "$BASE/schema_patch_v2b.js" /tmp/schema_patch_v2.pb.js $EXP_patch

echo "== [2/7] 下载前端 app10.html =="
dl "$BASE/app10.html" /tmp/app10.html $EXP_app

echo "== [3/7] 备份当前 index.html + 写入 4 个钩子 =="
if [ -f "$PUB/index.html" ]; then
  sudo cp "$PUB/index.html" "$PUB/index.html.bak.$(date +%Y%m%d%H%M)"
  echo "  ✓ 已备份旧 index.html → index.html.bak.$(date +%Y%m%d%H%M)"
fi
sudo cp /tmp/api_team.pb.js          "$HOOKS/api_team.pb.js"
sudo cp /tmp/api.pb.js               "$HOOKS/api.pb.js"
sudo cp /tmp/api_review.pb.js        "$HOOKS/api_review.pb.js"
sudo cp /tmp/schema_patch_v2.pb.js   "$HOOKS/schema_patch_v2.pb.js"
echo "  ✓ 钩子已写入 $HOOKS/"

echo "== [4/7] 重启 pocketbase（加载含补丁钩子）=="
sudo systemctl restart pocketbase
sleep 4
if ! sudo systemctl is-active --quiet pocketbase; then
  echo "  !! PB 未起来，排查：journalctl -u pocketbase -n 50"
  exit 1
fi
echo "  ✓ pocketbase 已启动"

echo "== [5/7] 执行 schema 补丁（memberships 表 + invitations 新字段 + 存量回填）=="
curl -s "http://127.0.0.1:8090/api/patch/v2?tok=$TOK" -o /tmp/patch.json
echo "----- patch 返回 -----"; cat /tmp/patch.json; echo; echo "---------------------"
if ! grep -q '"ok":true' /tmp/patch.json || ! grep -q '"match":true' /tmp/patch.json; then
  echo "  !! 补丁未返回 ok:true 且 match:true，中止。"
  echo "     补丁钩子保留在 $HOOKS/schema_patch_v2.pb.js 供排查，请勿删除后重启。"
  exit 1
fi
echo "  ✓ 补丁成功：match=true（active 成员数 === 有 org_id 的用户数）"

echo "== [6/7] 删除一次性补丁钩子并重启 =="
sudo rm -f "$HOOKS/schema_patch_v2.pb.js"
sudo systemctl restart pocketbase
sleep 4
if ! sudo systemctl is-active --quiet pocketbase; then
  echo "  !! PB 未起来，排查：journalctl -u pocketbase -n 50"
  exit 1
fi
echo "  ✓ pocketbase 已重启（仅常驻 3 钩子）"

echo "== [7/7] 部署前端 app10.html → index.html（并保留 app10.html 作回退）=="
sudo cp /tmp/app10.html "$PUB/index.html"
sudo cp /tmp/app10.html "$PUB/app10.html"
echo "  ✓ 前端已部署"

echo ""
echo "DONE ✅ 部署完成。"
echo "  浏览器硬刷新（Ctrl/Cmd+Shift+R）：http://106.55.14.231/"
echo "  回退方式：sudo cp $PUB/index.html.bak.* $PUB/index.html 后刷新"
echo "  验证补丁结果：cat /tmp/patch.json"
