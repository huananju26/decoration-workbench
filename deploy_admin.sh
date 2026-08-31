#!/usr/bin/env bash
# 焕安居装修工作台 · 运营后台部署（固定地址版）
#
# 【为什么中转站要换文件名，但服务器上是固定名】
#   GitHub Pages 只是"文件中转站"，它有 cache-control: max-age=600。
#   若中转站上覆盖同名文件，服务器 curl 下来可能仍是旧副本 → 必须换名绕过。
#   但落到服务器后我们固定覆盖成 admin.html，所以：
#     👉 访问地址永远是  http://106.55.14.231/admin.html   （书签不会失效）
#     👉 中转站文件名每次递增（admin8 / admin9 / ...），仅为绕开中间缓存
#
# 【脚本还会做的一件事】
#   给 /admin.html 加 Cache-Control: no-store，彻底解决"覆盖了但浏览器还看旧的"。
#   带 caddy validate 校验，失败自动回滚，不会把站点搞挂。
#
# 用法（在 106.55.14.231 上执行，需 sudo）：
#   curl -sSL -o /tmp/da.sh https://huananju26.github.io/decoration-workbench/deploy_admin.sh
#   sudo bash /tmp/da.sh
#   # 高级：指定别的中转站文件名和字节
#   # sudo bash /tmp/da.sh admin9.html 31000
#
# 不动钩子、不重启 PocketBase。

SRC="${1:-admin10.html}"
EXP="${2:-32278}"

BASE="https://huananju26.github.io/decoration-workbench"
PUB="/opt/pocketbase/pb_public"
TARGET="$PUB/admin.html"

echo "=========================================="
echo "运营后台部署 → 固定地址 /admin.html"
echo "=========================================="

# ---------- [1/4] 下载（换名绕过 Pages 缓存） ----------
echo "== [1/4] 下载 $SRC =="
got=0
for try in 1 2 3; do
  curl -sSL --max-time 120 -o /tmp/"$SRC" "$BASE/$SRC"
  got=$(wc -c < /tmp/"$SRC")
  if [ "$got" = "$EXP" ]; then break; fi
  echo "  !! 字节不符（期望 $EXP 实际 $got），${try}/3，20s 后重试…"
  sleep 20
done
if [ "$got" != "$EXP" ]; then
  echo "  !! 三次仍不符，中止（Pages 可能未同步）。确认：$BASE/$SRC"
  exit 1
fi
echo "  ✓ $SRC = $got 字节"

# ---------- [2/4] 覆盖固定地址 ----------
echo "== [2/4] 覆盖 $TARGET =="
if [ -f "$TARGET" ]; then
  sudo cp "$TARGET" "$TARGET.bak.$(date +%Y%m%d_%H%M%S)"
  echo "  ✓ 已备份旧版 → $(basename "$TARGET").bak.*"
fi
sudo cp /tmp/"$SRC" "$TARGET"
echo "  ✓ 已覆盖，访问地址不变：http://106.55.14.231/admin.html"

# ---------- [3/4] Caddy 加 no-cache（可选，失败不影响部署） ----------
echo "== [3/4] 给 /admin.html 加 no-cache 头 =="
if command -v caddy >/dev/null 2>&1 && [ -f /etc/caddy/Caddyfile ]; then
  printf '%s\n' \
    'import sys' \
    'P = "/etc/caddy/Caddyfile"' \
    's = open(P, encoding="utf-8").read()' \
    'if "nocache_admin" in s:' \
    '    print("  - 规则已存在，跳过")' \
    '    sys.exit(0)' \
    'lines = s.split("\n")' \
    'idx = None' \
    'best = None' \
    'for i, ln in enumerate(lines):' \
    '    if ln.strip().startswith("reverse_proxy"):' \
    '        ind = len(ln) - len(ln.lstrip())' \
    '        if best is None or ind < best:' \
    '            best = ind' \
    '            idx = i' \
    'if idx is None:' \
    '    print("  !! 未找到 reverse_proxy 行，跳过（不影响部署）")' \
    '    sys.exit(0)' \
    'ind = lines[idx][:len(lines[idx]) - len(lines[idx].lstrip())]' \
    'block = [ind + "@nocache_admin path /admin.html",' \
    '         ind + "header @nocache_admin Cache-Control \"no-store, no-cache, must-revalidate\""]' \
    'lines[idx:idx] = block' \
    'open(P, "w", encoding="utf-8").write("\n".join(lines))' \
    'print("  - 已插入 no-cache 规则")' \
    > /tmp/patch_caddy_admin.py

  CB="/etc/caddy/Caddyfile.bak.$(date +%Y%m%d_%H%M%S)"
  sudo cp /etc/caddy/Caddyfile "$CB"
  if sudo python3 /tmp/patch_caddy_admin.py; then
    if sudo caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
      sudo systemctl reload caddy >/dev/null 2>&1 && echo "  ✓ Caddy 已重载（后台不再被浏览器缓存）"
    else
      sudo cp "$CB" /etc/caddy/Caddyfile
      echo "  !! 配置校验失败，已回滚 Caddyfile（后台仍可访问，只是需手动硬刷新）"
    fi
  else
    sudo cp "$CB" /etc/caddy/Caddyfile
    echo "  !! 打补丁异常，已回滚 Caddyfile"
  fi
else
  echo "  - 未检测到 caddy/Caddyfile，跳过（请手动硬刷新 Ctrl/Cmd+Shift+R）"
fi

# ---------- [4/4] 清理历史副本提示 ----------
echo "== [4/4] 历史副本 =="
ls -1 "$PUB"/admin*.html 2>/dev/null | sed 's|.*/|  · |'
echo "  （admin.html 是唯一有效入口；其余为历史版本，可自行清理）"

echo ""
echo "DONE ✅ 完成。访问（一般刷新即可，无需硬刷新）："
echo "  http://106.55.14.231/admin.html"
echo ""
echo "  回滚：sudo cp $TARGET.bak.<时间戳> $TARGET"
