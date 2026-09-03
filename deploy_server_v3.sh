#!/usr/bin/env bash
# 焕安居装修工作台 · 团队版 全量部署（#410-#428）
# 用法（在 106.55.14.231 上执行，需 sudo）：
#   curl -sSL -o /tmp/d3.sh https://huananju26.github.io/decoration-workbench/deploy_server_v3.sh
#   sudo bash /tmp/d3.sh
#
# 本脚本做的事：
#   1) 从 GitHub Pages 中转站拉后端钩子（数量见下方 HOOK_N）+ 前端 app24.html + 运营后台 admin10.html
#   2) 字节校验（不一致=gh-pages 未同步，自动重试一次）
#   3) 备份当前 pb_public/index.html（回退点）
#   4) 写入 HOOK_N 个常驻钩子（含 api_admin / api_cleanup / schema_patch_v3）+ 重启 PB
#   5) 部署前端 app24.html → index.html、运营后台 admin10.html → admin.html（固定地址）
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
EXP_api_team=29724     # api_team_v1.js       → pb_hooks/api_team.pb.js（#424 角色变更审计 + #447 成员列表返回 sections + 新增 POST /api/org/set-sections 把版块级权限写进 memberships）
EXP_api_multiorg=44786 # api_multiorg_v1.js   → pb_hooks/api.pb.js（#447 /api/me 增加 sections（当前用户版块级权限））（#429 注册 400 + 静默 catch 治理 + findRecordByFilter 不存在 + #430 邀请 role 兜底改 reader + 注册 save 段 try/catch + 移除 org_id/status 防御性 set（注册 400 真凶）+ 临时诊断路由 _diag_register 已验证删除 + #423 前端权限闸门后端配套（reader 写拦截）+ #424 服务端审计日志 audit_logs + /api/audit/list）
EXP_api_review=11800   # api_review_v2.js     → pb_hooks/api_review.pb.js
EXP_api_admin=9175     # api_admin_v1.js      → pb_hooks/api_admin.pb.js
EXP_api_cleanup=11121  # api_cleanup_v1.js    → pb_hooks/api_cleanup.pb.js
EXP_schema_patch_v3=5142 # schema_patch_v3.pb.js → pb_hooks/schema_patch_v3.pb.js（#430 角色候选值 8 值并集；修「集合不存在/无 role 字段」跳过分支误置 done=true 导致日志假阳性，详见 pb-pitfalls ⑭）
EXP_api_acct=16363     # api_acct_v1.js       → pb_hooks/api_acct.pb.js（#487 账户聚合 + /api/client/* 业主绑定；#491 修 bindcode 按 org_id 过滤（真字段名叫 org）+ 五处路由改走 client_bind_helpers 体检，报错区分表缺失/字段缺失/查询异常，不再一律甩锅「schema_patch_v5」）
EXP_client_bind_helpers=4424 # client_bind_helpers.js → pb_hooks/client_bind_helpers.js（#491 普通 .js 不是钩子，只被 api_acct.pb.js require；绑定表体检+查询封装）
EXP_schema_patch_v7=8712 # schema_patch_v7_client_bind.pb.js → pb_hooks/schema_patch_v7_client_bind.pb.js（#491 取代 v6：体检改按**字段名**比对，修掉 v6「数 fields.length 把 id/created/updated 三个系统字段也算上 → 字段一个没加成功仍判定通过并自我注销」的致命误判）
EXP_schema_patch_v8=4182 # schema_patch_v8_member_sections.pb.js → pb_hooks/schema_patch_v8_member_sections.pb.js（#447 给 memberships 补 sections 字段，让「编辑权限」的勾选随成员关系落库，不再只写管理员本机 localStorage）
EXP_app=1465387        # app24.html           → pb_public/index.html（#487 账户聚合弹窗：改名/改密走新 hook 路由 + 绑定装修公司后端 + 角色说明同步「供应调配」+ 退出按钮胶囊化 + 侧栏显示用户名；#488 修绑定弹窗 div 嵌套错位导致的竖排布局崩坏 + 新接口 404 友好提示）
                       #   #439 总价清单名称可点击跳转+删除重编号、删均价行、消除打印空白页、说明textarea自适应
                       #   #440 总价清单计算区动态化（删半包优惠一口价行、无主材隐藏管理费/主材合计）
                       #   #441 累计总金额计算链修复（不再吃半包优惠常量，删除项后总额随动）
                       #   #442 QUOTE_SEED 模板说明全补全（grep ', ''' =0 残留）
                       #   #443 说明编号规范化(268条)+累计5%协调费硬核修复(无主材=0)+新增空间模板undefined修复
                       #   #444 分类标题可编辑+分类删除、#445 分类序号固定+删除后自动重排
                       #   #446 付款方式4比例可手调（35/35/25/5 填空风格联动）
                       #   #447 权限管理「编辑权限」勾选真正生效：改走服务端 memberships.sections +
                       #        四个项目管理子板块（施工执行/合同收款/供应调配/客户交付）补读版块覆盖
                       #   #448 操作记录全局埋点：persist() 做数据指纹差分，业务增删改一律留痕
                       #   #449 刷新后左下角账户入口显示登录用户名（进工作台即刷新 + 身份回来再校正）
                       #   #446/#491 绑定弹窗：管理员视角增加「业主分享链接」（?bind=码，业主点开自动填入）
EXP_admin=32278        # admin10.html         → pb_public/admin.html（#426 徽章同行 + 套餐字号对齐）

# ─────────────────────────────────────────────────────────────────────────────
# 🩸 SHA256 内容校验（2026-09-03 血案后新增，必填）
#    事故：只校字节数 → curl -C - 续传把【上一次跑脚本留在 /tmp 的旧版文件】当成半成品，
#          从旧文件末尾接着写新文件尾部 → 长度恰好等于新大小、字节校验全过，
#          但内容 =「旧版正文 + 新版尾部」，3 个钩子语法崩坏（PB 静默跳过 → 全部路由 404）、
#          前端回退到旧版。大小没变的文件反而没事（续传起点=文件末尾=空操作）。
#    → 字节数只能证明「长度对」，证明不了「内容对」。必须上 sha256。
#    更新方式（本机）：cd gh-pages && shasum -a 256 <文件> | cut -d' ' -f1
# ─────────────────────────────────────────────────────────────────────────────
SHA_api_team=5bb273fc70e3e9e7a814e9941f46d1889032bb80cad70106739b2da178199a82
SHA_api_multiorg=0c2e3c61b3d388dac7e17e10509b622d45ed2f96ea2ec9fbb69074698c3b4cb5
SHA_api_review=1ed3827b94f72840544634ded7b5711d0d9fca927b11c4bafdc8eda7041ad413
SHA_api_admin=dbe8ba8e664f719cde9d61da298e12e8ae39e93c125322baa86373ff2bcace63
SHA_api_cleanup=a4774805fb588da90cdc2a88929ffde195ddd465c7cb59b4fc78abfc3888853c
SHA_schema_patch_v3=439e13b2e8d8baf42829e9e4f10d0b820e0f7c95ee60c89ad667e328bd79fd6b
SHA_api_acct=7b4e4cf9dbc63f13d76688c3fa2773a963e97298188cbc1661561f37058a93bf
SHA_client_bind_helpers=686fae44d3601f2a6c0bcb12e9eda11bb873de26a682046d5dd928191e8f4887
SHA_schema_patch_v7=fb60338d84b99072412a286fa56f02bfc6c55792b0562c3f8b43bc628ce411c1
SHA_schema_patch_v8=ae92a7d3eededaa07da4b7e478c4e37afebc23fc967a94ba4a17066ad093c314
SHA_app=9825e55a3ac424751e9678f95031ab9854de71b9afc00708d2d8da22ab6a79bd
SHA_admin=75e66a165c7183e71916d720c29ca13e7e9dfb21d0ef357df7c2703ab87f4be5

# 钩子数量。⚠️ 以前是写死在两处回显里的字面量，加第 6 个钩子（schema_patch_v3）时只改了
# 其中一处 → 回显自相矛盾（"写入 5 个钩子" / "6 个钩子已写入"）。改用变量，加钩子时改这里即可。
# ⚠️ 只数 *.pb.js（会被 PB 当钩子加载）。client_bind_helpers.js 是普通 .js，只被 require，不算。
HOOK_N=9

sha_of() { # file → sha256（服务器 Ubuntu 有 sha256sum；本机 macOS 有 shasum）
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum    >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else echo ""; fi
}

dl() { # url out expected_bytes expected_sha256
  # 🩸 2026-09-02 加固：服务器 → GitHub Pages 链路很慢，1.45MB 的 app24.html
  #   曾在 120s 硬性超时中断在 663669/1453374 字节，且每次重试都从 0 开始，永远下不完。
  #   → 断点续传(-C -) + 多轮 + 卡速(30 秒低于 1KB/s)自动断开重连。
  # 🩸🩸 2026-09-03 血案加固（本函数是事故现场，改之前先读这段）：
  #   原实现直接在 $out 上续传，且只校字节数。$out 是 /tmp 下的**跨运行保留**文件，
  #   上一次跑脚本留下的【旧版完整文件】会被当成「半成品」→ 从旧文件末尾接着写新文件尾部
  #   → 长度恰好等于新大小、字节校验全过，内容却是「旧正文 + 新尾部」。
  #   后果：api.pb.js / api_acct.pb.js / api_team.pb.js 三个钩子语法崩坏，PB 静默跳过加载
  #   （只打日志不报错）→ /api/me、/api/data/load 等全部 404；前端回退到旧版，肉眼完全看不出。
  #   三道防线：
  #     ① 只续传 $out.part（本轮自己写的半成品），绝不在 $out 上续传；
  #     ② 下完先校字节数，再校 sha256；
  #     ③ 任一不符 → 删 .part 全量重下一轮；仍不符 → 置 DL_FAIL 并中止整个部署（此时还没写任何文件）。
  local url="$1" out="$2" exp="$3" want="$4"
  local part="$out.part" got=0 try=0 h=""
  while [ "$try" -lt 6 ]; do
    try=$((try+1))
    got=0; [ -f "$part" ] && got=$(wc -c < "$part" | tr -d ' ')
    if [ "$got" = "$exp" ]; then
      h=$(sha_of "$part")
      if [ -n "$want" ] && [ "$h" != "$want" ]; then
        echo "  ↺ $(basename "$out") 长度对但内容不符（多半是续传拼了旧版）→ 删除重下"
        rm -f "$part"; got=0
      else
        break
      fi
    fi
    if [ "$got" -gt 0 ] && [ "$got" -lt "$exp" ]; then
      echo "  ↻ 续传 $(basename "$out"): 已下 $got/$exp 字节，第 $try 轮继续…"
      curl -sSL -C - --max-time 600 --speed-time 30 --speed-limit 1024 -o "$part" "$url" || true
    else
      # got=0 或 got>exp（续传撞上不支持 Range 的源导致文件被追加撑大）→ 删掉重下
      [ "$got" -gt "$exp" ] && echo "  ↺ $(basename "$out") 续传异常（$got > $exp），删除重下"
      rm -f "$part"
      curl -sSL --max-time 600 --speed-time 30 --speed-limit 1024 -o "$part" "$url" || true
    fi
  done
  got=0; [ -f "$part" ] && got=$(wc -c < "$part" | tr -d ' ')
  h="";  [ -f "$part" ] && h=$(sha_of "$part")
  # ⚠️ 必须 tr -d ' '：BSD/macOS 的 `wc -c < file` 输出带前导空格（"   24377"），GNU/Linux 不带
  if [ "$got" != "$exp" ]; then
    echo "  ❌ 下载不完整 $(basename "$out"): 期望 $exp 实际 $got（已重试 $try 轮）"
    DL_FAIL=1; return 0
  # ⚠️ 这里必须 return 0：脚本开头有 set -e，return 1 会让脚本当场静默退出，
  #    用户看不到「等 1-2 分钟重跑」的提示。统一交给下面的 DL_FAIL 闸门处理。
  fi
  if [ -n "$want" ] && [ "$h" != "$want" ]; then
    echo "  ❌ 内容校验失败 $(basename "$out"): sha256 期望 ${want:0:12}… 实际 ${h:0:12}…"
    echo "     最常见原因：GitHub Pages 还没传播完，拿到的是旧版文件。等 1-2 分钟重跑本脚本。"
    DL_FAIL=1; return 0
  # ⚠️ 这里必须 return 0：脚本开头有 set -e，return 1 会让脚本当场静默退出，
  #    用户看不到「等 1-2 分钟重跑」的提示。统一交给下面的 DL_FAIL 闸门处理。
  fi
  mv -f "$part" "$out"
  echo "  ✓ $(basename "$out") = $got 字节 · sha256 校验通过"
}

DL_FAIL=0
echo "== [1/5] 下载后端钩子（GitHub Pages 中转）=="
dl "$BASE/api_team_v1.js"     /tmp/api_team.pb.js     $EXP_api_team     $SHA_api_team
dl "$BASE/api_multiorg_v1.js" /tmp/api.pb.js          $EXP_api_multiorg $SHA_api_multiorg
dl "$BASE/api_review_v2.js"   /tmp/api_review.pb.js   $EXP_api_review   $SHA_api_review
dl "$BASE/api_admin_v1.js"    /tmp/api_admin.pb.js    $EXP_api_admin    $SHA_api_admin
dl "$BASE/api_cleanup_v1.js"  /tmp/api_cleanup.pb.js  $EXP_api_cleanup  $SHA_api_cleanup
dl "$BASE/schema_patch_v3.pb.js" /tmp/schema_patch_v3.pb.js $EXP_schema_patch_v3 $SHA_schema_patch_v3
dl "$BASE/api_acct_v1.js"     /tmp/api_acct.pb.js     $EXP_api_acct     $SHA_api_acct
dl "$BASE/client_bind_helpers.js" /tmp/client_bind_helpers.js $EXP_client_bind_helpers $SHA_client_bind_helpers
dl "$BASE/schema_patch_v7_client_bind.pb.js" /tmp/schema_patch_v7_client_bind.pb.js $EXP_schema_patch_v7 $SHA_schema_patch_v7
dl "$BASE/schema_patch_v8_member_sections.pb.js" /tmp/schema_patch_v8_member_sections.pb.js $EXP_schema_patch_v8 $SHA_schema_patch_v8

echo "== [2/5] 下载前端 app24.html + 运营后台 admin10.html =="
dl "$BASE/app24.html" /tmp/app24.html $EXP_app $SHA_app
dl "$BASE/admin10.html" /tmp/admin10.html $EXP_admin $SHA_admin

# 🩸 下载阶段没写任何文件（写钩子在 [3/5]、写前端在 [5/5]），此处中止 = 服务仍跑旧版，零风险。
#    宁可让用户看到明确的「等 1-2 分钟重跑」，也不要把拼坏的文件写进 pb_hooks。
if [ "$DL_FAIL" != "0" ]; then
  echo ""
  echo "❌ 有文件未下载完整或内容校验失败 → 已中止，pb_hooks / index.html 均未改动。"
  echo "   最常见原因：GitHub Pages 还没传播完（拿到旧版）。等 1-2 分钟重跑本脚本即可。"
  echo "   若连续多次失败，清掉缓存重来： sudo rm -f /tmp/*.pb.js.part /tmp/app24.html.part"
  exit 1
fi

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
sudo cp /tmp/api_acct.pb.js     "$HOOKS/api_acct.pb.js"
# 普通 .js（不是 .pb.js）：只被 api_acct.pb.js require，PB 不会把它当钩子加载
sudo cp /tmp/client_bind_helpers.js "$HOOKS/client_bind_helpers.js"
sudo cp /tmp/schema_patch_v7_client_bind.pb.js "$HOOKS/schema_patch_v7_client_bind.pb.js"
sudo cp /tmp/schema_patch_v8_member_sections.pb.js "$HOOKS/schema_patch_v8_member_sections.pb.js"
sudo rm -f "$HOOKS/schema_patch_v5_client_bind.pb.js"   # 旧版每分钟刷「建表失败」日志，已由 v6 → v7 取代
# ⚠️ v6 必须删：它的字段齐全判定是错的（数 fields.length，把 id/created/updated 三个系统字段算进去，
#    字段一个没加成功也会判定通过并 cronRemove），留着只会让人误以为绑定表是健康的。
sudo rm -f "$HOOKS/schema_patch_v6_client_bind.pb.js"
echo "  ✓ 附带模块 client_bind_helpers.js 已写入（供 api_acct.pb.js require）"

# ── 清理历史残留钩子（2026-09-03，用户授权）──
#   这两个都不在 HOOK_N=8 里，属于早期遗留：留着不影响功能，但每次 PB 启动都会白跑一遍。
#   ⚠️ 删之前务必确认「功能已由别处承接」，别删成次生事故（见 pb-pitfalls ②ⓐ）。
sudo rm -f "$HOOKS/api_sync.pb.js"                       # /api/sync/* 旧整包同步接口；单元化（B 方案）上线后已是死代码
sudo rm -f "$HOOKS/schema_patch_v4_lock_users.pb.js"     # 一次性安全补丁（users/org 字段锁定），早已落库，现为空跑
echo "  ✓ $HOOK_N 个钩子已写入 $HOOKS/（已清理 2 个历史残留：api_sync / schema_patch_v4_lock_users）"

echo "== [4/5] 重启 pocketbase（加载含 api_admin / api_cleanup / schema_patch_v3 的钩子集）=="
sudo systemctl restart pocketbase
sleep 4
if ! sudo systemctl is-active --quiet pocketbase; then
  echo "  !! PB 未起来，排查：journalctl -u pocketbase -n 50"
  exit 1
fi
echo "  ✓ pocketbase 已启动（$HOOK_N 钩子常驻）"
echo ""
echo "  ⏳ schema_patch_v3 / v7 / v8 走 cron（每分钟触发一次），不是启动即生效："
echo "     v3：约 1 分钟内把 invitations / access_requests / users 的 role 候选值扩为 8 值并集。"
echo "     v7：约 1 分钟内体检并补建 client_bind_codes / client_bindings 的字段（按字段名逐个比对）。"
echo "     v8：约 1 分钟内给 memberships 补 sections 字段（成员版块级权限落库）。"
echo "     三者打完补丁均自我注销（cronRemove）。"
echo "  📌 取证命令（看补丁到底做了什么、有没有自我注销）："
echo "       sudo journalctl -u pocketbase --since '-5min' | grep -E 'sp_v7|sp_v8'"
echo "     远程自查（无需登录：404=表不存在，403=表已存在）："
echo "       curl -o /dev/null -w '%{http_code}' 'http://106.55.14.231/api/collections/client_bind_codes/records?perPage=1'"
echo "     预期看到：v3「已生效，cron 自我注销」+ v6「两张表已就位，cron 自我注销」"

echo "== [5/5] 部署前端 app24.html → index.html + 运营后台 admin10.html → admin.html =="
sudo cp /tmp/app24.html "$PUB/index.html"
sudo cp /tmp/app24.html "$PUB/app24.html"
sudo cp /tmp/admin10.html "$PUB/admin.html"
echo "  ✓ 前端已部署（index.html / app24.html）"
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

# 🩸🩸 钩子加载自检（2026-09-03 事故后新增，这是唯一能当场抓到「钩子没加载」的检查）
#    血案：钩子文件被续传拼接搞成「旧正文+新尾部」→ 语法崩坏 → **PB 只打日志、不报错、照常启动**，
#    /api/health 照样 200、systemctl is-active 照样 active、字节数也照样对。
#    唯一破绽：那些路由根本没注册，全返回 404。所以必须真的去打路由。
#    ⚠️ 必须直连 PB 端口，不能走 127.0.0.1（Caddy）——Caddy 会把 PB 的 404 重写成 index.html 伪装成 200。
echo "  · 钩子路由注册自检（404 = 该钩子文件没被加载）："
PB=""
for p in 8090 8080; do
  c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 "http://127.0.0.1:$p/api/health" 2>/dev/null || echo 000)
  [ "$c" = "200" ] && PB="http://127.0.0.1:$p"
  [ -n "$PB" ] && break
done
if [ -z "$PB" ]; then
  echo "      （没探到 PB 直连端口，跳过；可手动：curl -o /dev/null -w '%{http_code}' http://127.0.0.1:8090/api/ping）"
else
  hook_ok=0; hook_bad=0
  for r in /api/ping /api/me /api/data/load /api/org/members /api/audit/list /api/client/bindcode /api/org/set-role /api/auth/send-code; do
    c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 6 "$PB$r" 2>/dev/null || echo 000)
    if [ "$c" = "404" ] || [ "$c" = "000" ]; then
      echo "      ❌ $r → $c（未注册）"; hook_bad=$((hook_bad+1))
    else
      hook_ok=$((hook_ok+1))
    fi
  done
  if [ "$hook_bad" = "0" ]; then
    echo "      ✓ $hook_ok 条钩子路由全部注册（$PB）"
  else
    echo "      ⚠️ $hook_bad 条未注册 → 钩子文件语法崩坏，PB 会静默跳过加载（服务照常起来，功能全废）"
    echo "         立刻看日志：sudo journalctl -u pocketbase -n 100 | grep -iE 'hook|error|panic'"
    echo "         紧急回退：git 取回上一版钩子 → cp 进 $HOOKS → sudo systemctl restart pocketbase"
  fi
fi

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
echo "  ✅ #487 账号管理：修改用户名 / 修改密码应成功（不再报 Only superusers）"
echo "  ✅ #487 邀请弹窗权限说明：项目经理应显示「施工执行、合同收款、供应调配、客户交付」（不再出现「成本管理」）"
echo "  ✅ #487 绑定装修公司：公司管理员打开弹窗能看到本公司绑定码；业主（无公司账号）提交绑定码后列表立即出现该公司"
echo '  ✅ #489 诊断路由已下线：/api/_diag/v6 应返回 SPA 兜底 HTML（PB 404 被 Caddy 重写），不是 JSON'
echo "  ✅ #489 自建绑定表：client_bind_codes / client_bindings 均返回 403（存在），不再是 404"
echo '     注：本机无法访问 github.io（代理 502），但可直连服务器 IP 自查'
echo "  ✅ #487 退出确认弹窗：红色「退出登录」按钮与「留在这里」同为胶囊圆角形"
echo "  ✅ #487 侧栏左下角按钮显示登录用户名（未登录时仍为「账户聚合」）"
echo "  ✅ #446/#491 绑定弹窗不再报「绑定表未就绪…schema_patch_v5」："
echo "       公司管理员打开「账号 ▸ 绑定装修公司」应看到本公司绑定码 + 业主分享链接 + 已绑定业主列表"
echo "       ⚠️ 若仍报错，报错文案会直接说明是「表尚未建立」还是「字段缺失」还是具体查询异常 —— 照文案处理，"
echo "          并可 sudo journalctl -u pocketbase --since '-5min' | grep sp_v7 看补丁自愈情况"
echo "  ✅ #447 权限管理 ▸ 编辑权限：勾选/取消后点保存，提示「权限已保存，该成员下次进入即生效」"
echo "       换该成员账号登录后，其侧栏可见版块应与勾选一致（服务端 memberships.sections 生效）"
echo "       项目管理四个子板块（施工执行/合同收款/供应调配/客户交付）勾选后也必须生效"
echo "  ✅ #448 操作记录：施工待办/节点/采购/收款/付款/日记/增减项/项目增删任一操作都应留下记录（不再只有成员变更）"
echo "  ✅ #449 刷新页面（Cmd/Ctrl+R）后，左下角直接显示登录用户名，不再是「👤 账户聚合」"
