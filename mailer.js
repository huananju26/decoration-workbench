// 邮件复用模块（PocketBase JSVM，被各路由 require 复用）
//
// 依赖后台 SMTP 设置：PocketBase 后台（/_/）→ Settings → Mail settings。
// 未配置 SMTP 时 smtpEnabled() 返回 false，调用方应回退到「开发模式」直返验证码/链接，
// 不能因为发不出邮件就阻断注册 / 邀请 / 找回密码主流程。
//
// 注意：JSVM 里每个路由回调在独立 JS 上下文执行，但 require 的模块是全局共享缓存的，
// 所以这里把发信逻辑抽成模块，各路由用 require(`${__hooks}/mailer.js`) 复用。

// 发件人：留空时由 PocketBase 后台 SMTP 设置里的「发件人」接管，避免与 SMTP 鉴权账号不一致被拒收。
// 若你的 SMTP 服务商允许自定义发件域名，可在此改成 '焕安居装修工作台 <noreply@your-domain.com>'。
const FROM = '';
const APP_BASE_URL = 'http://106.55.14.231/';

// 是否已在后台配置可用的 SMTP（enabled 且填了 host）
function smtpEnabled() {
  try {
    const st = $app.settings();
    let s = (typeof st.smtp === 'function') ? st.smtp() : (st.smtp || null);
    if (!s) return false;
    return !!(s.enabled && s.host);
  } catch (e) { return false; }
}

// 通用邮件外壳（深蓝系，与主程序视觉一致，无图片）
function mailShell(title, innerHtml) {
  let t = (title || '').replace(/[<>&]/g, function (c) {
    return c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;';
  });
  let body = (innerHtml || '')
    .replace(/<(?!\/?(p|div|a|span|b|br|style)\b)[^>]*>/gi, ''); // 仅保留基础排版标签
  return ''
    + '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',\'PingFang SC\',\'Microsoft YaHei\',sans-serif;background:#f5f7fa;padding:24px">'
    + '<div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e8e8e8;border-radius:12px;overflow:hidden">'
    + '<div style="background:#003a8c;color:#fff;padding:16px 22px;font-size:16px;font-weight:600">焕安居装修工作台</div>'
    + '<div style="padding:22px;font-size:14px;line-height:1.8;color:#333">'
    + '<div style="font-size:15px;font-weight:600;color:#1a1a1a;margin-bottom:12px">' + t + '</div>'
    + body
    + '</div>'
    + '<div style="padding:14px 22px;background:#fafafa;border-top:1px solid #eee;font-size:12px;color:#999">本邮件由系统自动发送，请勿直接回复。</div>'
    + '</div></div>';
}

// 真实发送：依赖 $app.send()（底层走后台 SMTP 设置）
function sendMail(to, subject, html, text) {
  const { MailerMessage } = require('pocketbase');
  const msg = {
    to: to,
    subject: subject,
    html: html,
    text: text || (html ? html.replace(/<[^>]+>/g, ' ') : '')
  };
  if (FROM) msg.from = FROM;
  const message = new MailerMessage(msg);
  $app.send(message);
}

module.exports = { FROM, APP_BASE_URL, smtpEnabled, mailShell, sendMail };
