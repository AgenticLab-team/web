/**
 * 帖子里的图片可以从哪儿来。纯函数。
 *
 * ─────────────────────────────────────────
 * 为什么要有白名单
 * ─────────────────────────────────────────
 *
 * `img` 一直是放行标签，而 `src` 一直没人管。也就是说任何人都能在
 * 帖子里放一张指向自己服务器的图 —— 每一个打开这篇帖子的人，
 * 浏览器都会自动去请求它一次。
 *
 * 一张 1×1 的透明图就足够把「谁、在什么时候、用什么设备读了这篇」
 * 连同 IP 一起送到那台服务器上。读者不点任何东西，也看不到任何异样。
 * 在一个把隐私当卖点的站上，这是最安静的那种泄露。
 *
 * 名单短是故意的 —— 每加一个域名，就多一个能悄悄统计读者的人。
 */

/**
 * 允许直接渲染成图片的域名。
 *
 * · files.mrusercontent.com —— 自己的图床，站内上传的落点
 * · 三个微信域名 —— 头像。它们已经在 next.config 的 remotePatterns 里，
 *   两处保持一致；只在一处放行的话，头像会在其中一条路径上变成裂图
 */
export const ALLOWED_IMAGE_HOSTS = [
  "files.mrusercontent.com",
  "wx.qlogo.cn",
  "mmhead.hk.wechat.com",
  "wework.qpic.cn",
] as const;

export function isAllowedImageSource(src: string): boolean {
  if (!src) return false;

  /*
   * 相对路径放行：那是本站自己的资源（/icons/... 之类），
   * 请求打到本站，不构成对外泄露。
   *
   * 但 `//example.com/x.png` 这种「协议相对」的写法**不算相对路径** ——
   * 它会去请求 example.com。这一条特别容易漏，因为它以 `/` 开头。
   */
  if (src.startsWith("/") && !src.startsWith("//")) return true;

  /*
   * data: 一律不放行。
   *
   * 它不会发出请求，看起来无害 —— 但一张几百 KB 的 base64 图会
   * 整个塞进帖子正文里存进数据库，而正文是要被全文索引、
   * 被同步、被导出的。真想发图，走上传。
   */
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return false;
  }

  if (url.protocol !== "https:") return false;
  // 逐字比对主机名，不用 endsWith —— `evil-files.mrusercontent.com.attacker.net`
  // 能骗过任何一种「包含」式的判断
  return (ALLOWED_IMAGE_HOSTS as readonly string[]).includes(url.hostname);
}
