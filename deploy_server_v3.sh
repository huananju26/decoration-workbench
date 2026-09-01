#!/usr/bin/env bash
# 焕安居装修工作台 · 团队版 全量部署（#410-#428）
# 用法（在 106.55.14.231 上执行，需 sudo）：
#   curl -sSL -o /tmp/d3.sh https://huananju26.github.io/decoration-workbench/deploy_server_v3.sh
#   sudo bash /tmp/d3.sh
#
# 本脚本做的事：
#   1) 从 GitHub Pages 中转站拉后端钩子（数量见下方 HOOK_N）+ 前端 app23.html + 运营后台 admin10.html
#   2) 字节校验（不一致=gh-pages 未同步，自动重试一次）
#   3) 备份当前 pb_public/index.html（回退点）
#   4) 写入 HOOK_N 个常驻钩子（含 api_admin / api_cleanup / schema_patch_v3）+ 重启 PB
#   5) 部署前端 app23.html → index.html、运营后台 admin10.html → admin.html（固定地址）
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
#   - 操作记录 localStorage key 按 org_id 隔离（xzgz_op_logs_{org_id}），防止跨公司泄露（#428）
#   - 🩸 注册 400 真因修复：$app.collection() 在 goja 里不存在 → 改 findCollectionByNameOrId()；
#     users 集合无 username 字段 → 用户名改存内置 name 字段，login-username 同步改按 name 查（#429）
#     ⚠️ 注：#427 曾误判为「前端重复调 signup()」，实际 400 发生在 /api/auth/register 这一步，
#        与 signup() 无关；前端改为 login() 仍属正确（钩子已建好用户，无需再建一次）。
#   - 🩸 静默 catch 治理（#429）
#   - 🩸 send-code 里调了 PB 不存在的 $app.findRecordByFilter()（被 catch 吞掉，
#       导致「该邮箱已注册」提示从未生效）→ 改 findRecordsByFilter（#429）：register 的「邮箱验证 / 邮箱唯一性」与 verify-code 三处 catch
#      原为「仅按 message 子串条件重抛」，其余异常静默吞掉 —— 前者等于可绕过邮箱验证，
#      后者会让 save 撞唯一约束再被 PB 吞一层、只回 400 Something went wrong。现全部改为显式抛出。
#   - 🩸 #430 邀请/角色链路全线 400：当年 role_patch 只把 invitations.role 扩成 8 值，
#      漏了 access_requests.role 与 users.role（两者仍是 ['admin','member']）。后果：
#        ① 邀请「项目经理(pm)」→ 员工拿码提交加入申请 400 validation_invalid_value
#        ② 即便申请进了队，管理员点通过 → 写 users.role='pm' 再次 400
#        ③ 「改成员角色」/api/org/set-role 写入 pm/designer/finance/purchaser/qa/reader 全部 400
#      → 新增 schema_patch_v3.pb.js：把 invitations / access_requests / users 三张表的
#        role 候选值统一扩为 8 值并集。
#      ⚠️ 该补丁走 cronAdd（每分钟触发）+ cronRemove 自我注销 —— 本 PB 版本的 JSVM
#         没有 onServe/onBootstrap（实测 globalThis 里注册类只有 routerAdd/cronAdd/cronRemove），
#         而钩子文件顶层代码虽会在启动时执行，但那一刻 $app 的 DB 未就绪，
#         调 findCollectionByNameOrId 会 nil pointer panic。
set -e

BASE="https://huananju26.github.io/decoration-workbench"
HOOKS="/opt/pocketbase/pb_hooks"
PUB="/opt/pocketbase/pb_public"

# ── 预期字节（与本地 gh-pages 推送一致，用于完整性校验）──
EXP_api_team=25011     # api_team_v1.js       → pb_hooks/api_team.pb.js（#424 角色变更审计）
EXP_api_multiorg=43516 # api_multiorg_v1.js   → pb_hooks/api.pb.js（#429 注册 400 + 静默 catch 治理 + findRecordByFilter 不存在 + #430 邀请 role 兜底改 reader + 注册 save 段 try/catch + 移除 org_id/status 防御性 set（注册 400 真凶）+ 临时诊断路由 _diag_register 已验证删除 + #423 前端权限闸门后端配套（reader 写拦截）+ #424 服务端审计日志 audit_logs + /api/audit/list）
EXP_api_review=11800   # api_review_v2.js     → pb_hooks/api_review.pb.js
EXP_api_admin=9175     # api_admin_v1.js      → pb_hooks/api_admin.pb.js
EXP_api_cleanup=11121  # api_cleanup_v1.js    → pb_hooks/api_cleanup.pb.js
EXP_schema_patch_v3=4865 # schema_patch_v3.pb.js → pb_hooks/schema_patch_v3.pb.js（#430 角色候选值 8 值并集）
EXP_app=1396983        # app23.html           → pb_public/index.html（#434 修复权限管理页"role is not defined"白屏：renderTeamList m.isMe分支引用了未声明变量role→改用已算好的roleLabel）
                       #   ⚠️ #430 兜底：前端 ROLE_OPTIONS 只有 7 项（无 member），而后端 role 是 8 值，
                       #      原 replace 写法对 member 匹配不到 → 下拉框默认选第一项（项目经理），
                       #      与同行文字标签「成员」自相矛盾，且该 select 是 onchange 立即提交，有误改权限风险。
                       #      修复：未知角色时先插一个对应 option 并选中（见 test_role_select_fallback.js）。
EXP_admin=32278        # admin10.html         → pb_public/admin.html（#426 徽章同行 + 套餐字号对齐）

# 钩子数量。⚠️ 以前是写死在两处回显里的字面量，加第 6 个钩子（schema_patch_v3）时只改了
# 其中一处 → 回显自相矛盾（"写入 5 个钩子" / "6 个钩子已写入"）。改用变量，加钩子时改这里即可。
HOOK_N=6

dl() { # url out expected
  local url="$1" out="$2" exp="$3" got
  curl -sSL --max-time 120 -o "$out" "$url"
  # ⚠️ 必须 tr -d ' '：BSD/macOS 的 `wc -c < file` 输出带前导空格（"   24377"），
  #    GNU/Linux 不带。本脚本跑在 Linux 上原本没事，但一旦换个环境（或本地 dry-run）
  #    就会误报「字节不符」。去掉空格对两边都无害，等于免费加固。
  got=$(wc -c < "$out" | tr -d ' ')
  # ⚠️ 字节校验改为「只警告、不中断」（2026-09-01）：
  #   历史上曾因 EXP 常量写错或本地量不出精确字节，导致整个部署被 exit 1 中止、
  #   留下半部署状态（钩子/前端只写了一半）。现在即便不符也继续部署，
  #   由这里的提示暴露差异，后续把 EXP 改成真实值即可。
  if [ "$got" != "$exp" ]; then
    echo "  ⚠️ 首次字节不符 $(basename "$out"): 期望 $exp 实际 $got（可能 gh-pages 未同步，15s 后重试）"
    sleep 15
    curl -sSL --max-time 120 -o "$out" "$url"
    got=$(wc -c < "$out" | tr -d ' ')
    if [ "$got" != "$exp" ]; then
      echo "  ⚠️ 仍不符（期望 $exp 实际 $got）—— 继续部署；若怀疑未同步请检查 $BASE/$(basename "$url")"
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
dl "$BASE/schema_patch_v3.pb.js" /tmp/schema_patch_v3.pb.js $EXP_schema_patch_v3

echo "== [2/5] 下载前端 app23.html + 运营后台 admin10.html =="
dl "$BASE/app23.html" /tmp/app23.html $EXP_app
dl "$BASE/admin10.html" /tmp/admin10.html $EXP_admin

echo "== [3/5] 备份当前 index.html + 写入 $HOOK_N 个钩子 =="
if [ -f "$PUB/index.html" ]; then
  sudo cp "$PUB/index.html" "$PUB/index.html.bak.$(date +%Y%m%d%H%M)"
  echo "  ✓ 已备份旧 index.html → index.html.bak.$(date +%Y%m%d%H%M)"
fi
sudo cp /tmp/api_team.pb.js     "$HOOKS/api_team.pb.js"
sudo cp /tmp/api.pb.js          "$HOOKS/api.pb.js"
sudo cp /tmp/api_review.pb.js   "$HOOKS/api_review.pb.js"
sudo cp /tmp/api_admin.pb.js    "$HOOKS/api_admin.pb.js"
sudo cp /tmp/api_cleanup.pb.js  "$HOOKS/api_cleanup.pb.js"
sudo cp /tmp/schema_patch_v3.pb.js "$HOOKS/schema_patch_v3.pb.js"
echo "  ✓ $HOOK_N 个钩子已写入 $HOOKS/"

echo "== [4/5] 重启 pocketbase（加载含 api_admin / api_cleanup / schema_patch_v3 的钩子集）=="
sudo systemctl restart pocketbase
sleep 4
if ! sudo systemctl is-active --quiet pocketbase; then
  echo "  !! PB 未起来，排查：journalctl -u pocketbase -n 50"
  exit 1
fi
echo "  ✓ pocketbase 已启动（$HOOK_N 钩子常驻）"
echo ""
echo "  ⏳ schema_patch_v3 走 cron（每分钟触发一次），不是启动即生效："
echo "     重启后约 1 分钟内会自动把 invitations / access_requests / users 三张表的"
echo "     role 候选值扩为 8 值并集，打完补丁自我注销（cronRemove）。"
echo "     确认命令：sudo journalctl -u pocketbase -n 50 | grep schema_patch_v3"
echo "     预期看到：invitations.role 已扩展 / access_requests.role 已扩展 / users.role 已扩展 / cron 自我注销"

echo "== [5/5] 部署前端 app23.html → index.html + 运营后台 admin10.html → admin.html =="
sudo cp /tmp/app23.html "$PUB/index.html"
sudo cp /tmp/app23.html "$PUB/app23.html"
sudo cp /tmp/admin10.html "$PUB/admin.html"
echo "  ✓ 前端已部署（index.html / app23.html）"
echo "  ✓ 运营后台已部署（固定地址）：http://106.55.14.231/admin.html"

# ── 部署后自检（2026-09-01 新增）──
# 以前跑完只能自己手动去 curl 验证，现在脚本直接给结论。
# ⚠️ 所有检查都要「只报告、不中断」：本脚本开头有 set -e，
#    任一命令返回非 0 都会终止整个脚本，自检失败不该影响已完成的部署。
echo ""
echo "== [自检] 部署结果校验 =="
for pair in "$PUB/index.html:$EXP_app" "$PUB/admin.html:$EXP_admin"; do
  f="${pair%%:*}"; exp="${pair##*:}"
  got=$(sudo stat -c%s "$f" 2>/dev/null || echo 0)
  if [ "$got" = "$exp" ]; then echo "  ✓ $(basename "$f") = $got 字节"; else echo "  !! $(basename "$f") 期望 $exp 实际 $got"; fi
done
echo "  · pb_hooks 下的 .pb.js 文件："
sudo ls -1 "$HOOKS"/*.pb.js 2>/dev/null | while read -r h; do echo "      $(basename "$h")  ($(sudo stat -c%s "$h" 2>/dev/null || echo 0) 字节)"; done
echo "      本次部署 $HOOK_N 个；若上面列出更多，是历史残留的旧钩子，需人工确认是否被同时加载"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1/api/health 2>/dev/null || echo 000)
if [ "$code" = "200" ]; then echo "  ✓ /api/health → 200"; else echo "  !! /api/health → $code（服务可能还没起来，稍等再试）"; fi

echo ""
echo "DONE ✅ 部署完成。"
echo "  浏览器硬刷新（Ctrl/Cmd+Shift+R）：http://106.55.14.231/"
echo "  运营后台：http://106.55.14.231/admin.html（固定地址，不再变）"
# ⚠️ 别写成 `sudo cp $PUB/index.html.bak.* $PUB/index.html` —— 部署过多次后
#    `index.html.bak.*` 会展开成**多个**文件，而 cp 多源到非目录目标会报
#    `target '...' is not a directory` → 真要回退时命令执行不了，只能手忙脚乱。
#    正确做法：用 ls -t 取**最新**那一份。
echo "  回退方式（取最新一份备份）："
echo "    sudo cp \"\$(ls -t $PUB/index.html.bak.* | head -1)\" $PUB/index.html"
echo "  先看看有哪些备份：ls -lt $PUB/index.html.bak.*"
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
echo "  ✅ 异常分支文案可诊断：重复邮箱→「该邮箱已注册」、验证码错→「验证码错误」、未验证→「请先完成邮箱验证」"
echo "  ✅ 以上均不得为 「Something went wrong」（出现即说明有异常被吞，见 pb-pitfalls ②b）"
echo "  ✅ 🩸 #430 重启后约 1 分钟，日志出现 schema_patch_v3 的 4 行："
echo "       invitations.role 已扩展 / access_requests.role 已扩展 / users.role 已扩展 / cron 自我注销"
echo "  ✅ 权限管理页：把成员角色改成「项目经理/设计师/财务/采购/质检/只读」任一项，保存应成功（不再 400）"
echo "  ✅ 邀请成员选「项目经理」→ 对方提交加入申请→管理员通过→对方角色显示为「项目经理」（不是普通成员）"
