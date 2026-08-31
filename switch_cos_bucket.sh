#!/bin/bash
# ============================================================
#  COS 桶切换脚本
#  目的：多 AZ 旧桶（贵、无免费额度）→ 单 AZ 标准存储新桶（享企业 1TB 免费 6 个月）
#  旧桶：huananju-1258596624     （多 AZ）
#  新桶：huananju2026-1258596624 （单 AZ / 标准存储）
#
#  原理：cossign 签名服务的桶名来自环境变量 /etc/cossign.env，
#        改环境变量 + 重启服务即完成切换，前端代码零改动。
#  用法：sudo bash /tmp/switch_cos.sh
# ============================================================

OLD_BUCKET="huananju-1258596624"
NEW_BUCKET="huananju2026-1258596624"
ENV_FILE="/etc/cossign.env"
HEALTH_URL="http://127.0.0.1:8091/health"

# 读取 env 文件里的某个变量值（自动剥掉可能存在的首尾双引号和 Windows 回车）
envval() {
  sudo grep "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '\r' \
    | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

echo "=========================================="
echo " COS 桶切换：多 AZ → 单 AZ 标准存储"
echo "=========================================="
echo ""

# ---------- [1/5] 前置检查 ----------
echo "== [1/5] 前置检查 =="
if [ ! -f "$ENV_FILE" ]; then
  echo "❌ 找不到 $ENV_FILE，脚本终止"
  exit 1
fi
echo "✅ 环境变量文件存在：$ENV_FILE"

CUR_BUCKET=$(envval COS_BUCKET)
CUR_REGION=$(envval COS_REGION)
echo "   当前桶名：${CUR_BUCKET:-（未设置）}"
echo "   当前地域：${CUR_REGION:-（未设置）}"
echo ""

# ---------- [2/5] 备份 ----------
echo "== [2/5] 备份环境变量文件 =="
BAK="${ENV_FILE}.bak.$(date +%Y%m%d_%H%M%S)"
sudo cp "$ENV_FILE" "$BAK"
sudo chmod 600 "$BAK"
echo "✅ 已备份到：$BAK"
echo ""

# ---------- [3/5] 切换桶名 ----------
echo "== [3/5] 切换桶名 =="
sudo sed -i "s|^COS_BUCKET=.*|COS_BUCKET=${NEW_BUCKET}|" "$ENV_FILE"

# 地域兜底：若未设置或为空，补成广州
if [ -z "$CUR_REGION" ]; then
  echo "   ⚠️ COS_REGION 未设置，补充为 ap-guangzhou"
  if sudo grep -q '^COS_REGION=' "$ENV_FILE"; then
    sudo sed -i "s|^COS_REGION=.*|COS_REGION=ap-guangzhou|" "$ENV_FILE"
  else
    echo "COS_REGION=ap-guangzhou" | sudo tee -a "$ENV_FILE" > /dev/null
  fi
fi

NEW_CUR_BUCKET=$(envval COS_BUCKET)
NEW_CUR_REGION=$(envval COS_REGION)
echo "   新桶名：$NEW_CUR_BUCKET"
echo "   新地域：$NEW_CUR_REGION"
echo ""

# ---------- [4/5] 重启服务 ----------
echo "== [4/5] 重启 cossign 服务 =="
sudo systemctl restart cossign
sleep 3
SVC_STATUS=$(systemctl is-active cossign 2>/dev/null)
echo "   服务状态：$SVC_STATUS"
if [ "$SVC_STATUS" != "active" ]; then
  echo ""
  echo "❌ 服务未正常启动，查看日志："
  sudo journalctl -u cossign -n 20 --no-pager
  echo ""
  echo "回滚命令：sudo cp $BAK $ENV_FILE && sudo systemctl restart cossign"
  exit 1
fi
echo "✅ 服务已重启"
echo ""

# ---------- [5/5] 验证 ----------
echo "== [5/5] 验证（/health 端点）=="
HEALTH=$(curl -s --max-time 5 "$HEALTH_URL")
echo "   $HEALTH"
echo ""

if echo "$HEALTH" | grep -q "$NEW_BUCKET"; then
  echo "=========================================="
  echo " ✅ 切换成功！服务已指向新桶 $NEW_BUCKET"
  echo "=========================================="
  echo ""
  echo "⚠️ 还需你手工确认两件事（脚本做不了）："
  echo "  1. 【必须】新桶配 CORS 规则（否则浏览器直传被拦，照片会静默退回 base64）"
  echo "     COS 控制台 → 新桶 → 安全管理 → 跨域访问 CORS → 添加规则："
  echo "       AllowedOrigins: *"
  echo "       Methods: GET PUT POST DELETE HEAD 全勾"
  echo "       AllowedHeaders: *"
  echo "       ExposeHeaders: ETag"
  echo "       MaxAge: 600"
  echo "  2. 【验证】上传一张新照片测试，确认 stored=cos 且能正常显示"
  echo ""
  echo "📌 老照片说明：旧桶 huananju-1258596624 里的照片不会自动迁移，"
  echo "   切换后历史照片会 404。当前存量很小，如需保留再单独迁移。"
  echo ""
  echo "🔙 回滚命令（如需）："
  echo "   sudo cp $BAK $ENV_FILE && sudo systemctl restart cossign"
else
  echo "=========================================="
  echo " ❌ 验证失败：/health 未返回新桶名"
  echo "=========================================="
  echo ""
  echo "可能原因：① cossign 服务未读取到新环境变量 ② 新桶 CAM 权限不足"
  echo "诊断：sudo journalctl -u cossign -n 30 --no-pager"
  echo "回滚：sudo cp $BAK $ENV_FILE && sudo systemctl restart cossign"
  exit 1
fi
