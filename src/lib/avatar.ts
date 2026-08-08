/**
 * 微信头像 URL 归一化。
 *
 * 上游返回的头像域名有两个（wx.qlogo.cn 与 mmhead.hk.wechat.com），
 * 协议也不统一 —— 部分是 http。本站是 HTTPS，直接用 http 图片会被浏览器
 * 当作混合内容拦掉，表现为头像整个不显示，而且控制台之外没有任何提示。
 *
 * 两个域名都支持 https，所以统一升级协议即可。
 */

const ALLOWED_HOSTS = new Set(["wx.qlogo.cn", "mmhead.hk.wechat.com", "wework.qpic.cn"]);

export function normalizeAvatarUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  // 只接受已知的微信头像域名，避免这个字段变成任意图片注入点
  if (!ALLOWED_HOSTS.has(parsed.hostname)) return null;

  parsed.protocol = "https:";
  return parsed.toString();
}
