#!/usr/bin/env bash
# 焕安居装修工作台 · 团队版 全量部署（#410-#428）
# 用法（在 106.55.14.231 上执行，需 sudo）：
#   curl -sSL -o /tmp/d3.sh https://huananju26.github.io/decoration-workbench/deploy_server_v3.sh
#   sudo bash /tmp/d3.sh
#
# 本脚本做的事：
#   1) 从 GitHub Pages 中转站拉 5 个后端钩子 + 前端 app22.html + 运营后台 admin10.html
#   2) 字节校验（不一致=gh-pages 未同步，自动重试一次）
#   3) 备份当前 pb_public/index.html（回退点）
#   4) 写入 5 个常驻钩子（含 api_admin / api_cleanup）+ 重启 PB
#   5) 部署前端 app22.html → index.html、运营后台 admin10.html → admin.html（固定地址）
#
# 本次重点修复：
#   - 侧栏「影像资料」+「储存套餐」合并为「存储影像」（归企业设置组，套餐在上/影像在下，#425）
#   - 运营后台成员页拉不到（api_admin 此前未部署，本次补上）
#   - 改为试用套餐仍显示「付费」（同上）
#   - 全部公司页增加「设到期日」日期框 + 按钮（set_expiry 动作）
#   - 清理页「允许删除付费公司」勾选（purge_paid 受控覆盖）
#   - 影像资料筛选「节点验收」空结果（kind 映射修正）
#   - 影像资料筛选条五行→单行加固（!important + nowrap + 防width覆盖，#419）
#   - 到期日日期框空白修复（dateOnly 截取 YYYY-MM-DD，#421）
#   - 运营后台满屏自适应布局（去掉 max-width:1080px，#423）
#   - 开通新公司三字段加 * 必填标记（#424）
#   - 开通申请三项真校验（公司名/联系人/电话缺一不可）+ 提交后停留状态页、表单整块隐藏（#426）
#   - 运营后台公司列表：「试用/已付费」徽章紧跟「设为该套餐」、「冻结」紧跟「续期」（同一行，#426）
#   - 运营后台套餐下拉字号改为与公司名称一致（table select 用 1em，不再是全局 16px，#426）
#   - 清理页取消「允许删除付费公司」后，主动剔除残留的付费公司选中（#426）
#   - 新用户注册 HTTP 400 修复：/api/auth/register 钩子已创建用户，前端不再重复调 signup()（#427）
#   - 操作记录 localStorage key 按 org_id 隔离（xzgz_op_logs_{org_id}），防止跨公司泄露（#428）
#   - 🩸 注册 400 真因修复：$app.collection() 在 goja 里不存在 → 改 findCollectionByNameOrId()；
#     users 集合无 username 字段 → 用户名改存内置 name 字段，login-username 同步改按 name 查（#429）
set -e

BASE="https://huananju26.github.io/decoration-workbench"
HOOKS="/opt/pocketbase/pb_hooks"
PUB="/opt/pocketbase/pb_public"

# ── 预期字节（与本地 gh-pages 推送一致，用于完整性校验）──
EXP_api_team=24377     # api_team_v1.js       → pb_hooks/api_team.pb.js
EXP_api_multiorg=34644 # api_multiorg_v1.js   → pb_hooks/api.pb.js（#429 注册 400 修复）
EXP_api_review=11800   # api_review_v2.js     → pb_hooks/api_review.pb.js
EXP_api_admin=9175     # api_admin_v1.js      → pb_hooks/api_admin.pb.js
EXP_api_cleanup=11121  # api_cleanup_v1.js    → pb_hooks/api_cleanup.pb.js
EXP_app=1370066        # app22.html           → pb_public/index.html（#428 操作记录按 org_id 隔离）
EXP_admin=32278        # admin10.html         → pb_public/admin.html（#426 徽章同行 + 套餐字号对齐）

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

echo "== [2/5] 下载前端 app22.html + 运营后台 admin10.html =="
dl "$BASE/app22.html" /tmp/app22.html $EXP_app
dl "$BASE/admin10.html" /tmp/admin10.html $EXP_admin

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

echo "== [5/5] 部署前端 app22.html → index.html + 运营后台 admin10.html → admin.html =="
sudo cp /tmp/app22.html "$PUB/index.html"
sudo cp /tmp/app22.html "$PUB/app22.html"
sudo cp /tmp/admin10.html "$PUB/admin.html"
echo "  ✓ 前端已部署（index.html / app22.html）"
echo "  ✓ 运营后台已部署（固定地址）：http://106.55.14.231/admin.html"

echo ""
echo "DONE ✅ 部署完成。"
echo "  浏览器硬刷新（Ctrl/Cmd+Shift+R）：http://106.55.14.231/"
echo "  运营后台：http://106.55.14.231/admin.html（固定地址，不再变）"
echo "  回退方式：sudo cp $PUB/index.html.bak.* $PUB/index.html 后刷新"
echo ""
echo "  验证清单："
echo "  ✅ 侧栏「企业设置」组只剩一个「存储影像」（原影像资料/储存套餐已消失）"
echo "  ✅ 点进去上半部分是储存套餐（套餐/有效期/席位/用量条/分类统计），下半部分是影像资料"
echo "  ✅ 影像资料筛选条应为单行（搜索+项目+类型+时间+存储位置+重置）"
echo "  ✅ 运营后台「成员」页应列出所有成员"
echo "  ✅ 全部公司页每行有日期框 + 「设到期日」按钮"
echo "  ✅ 清理页有「允许删除付费公司」勾选；取消勾选后，之前选中的付费公司应自动取消选中"
echo "  ✅ 开通新公司：公司名/联系人/电话任一为空都会红字拦截，不会提交"
echo "  ✅ 开通申请提交后停在「审核中」状态页，① ② 表单整块消失（有刷新状态/重新申请/退出登录按钮）"
echo "  ✅ 运营后台公司列表：「已付费/试用」徽章在「设为该套餐」按钮同一行右侧；「冻结」在「续期」同一行右侧"
echo "  ✅ 套餐下拉字号与公司名称一致（不再明显大一号）"
echo "  ✅ 🩸 新用户注册：填邮箱+验证码+用户名+密码后应成功进入「创建/加入公司」页，不再报 HTTP 400"
echo "  ✅ 注册后用「用户名」或「邮箱」都能登录（用户名现在存在内置 name 字段里）"
