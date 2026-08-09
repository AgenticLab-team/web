/**
 * 图床。纯函数，不碰网络也不碰数据库。
 *
 * ─────────────────────────────────────────
 * 这个站到今天为止没有任何上传
 * ─────────────────────────────────────────
 *
 * markdown 里 `img` 早就是放行的标签，但没有任何地方能产生一张图 ——
 * 想发图只能自己去别处传好再把链接粘进来。而那正是问题所在：
 * 帖子里那些 `src` 指向的是**别人的服务器**，每一个读者打开帖子
 * 都会去请求它一次。一张 1×1 的透明图就够把「谁在什么时候读了这篇」
 * 连同 IP 和 UA 送到那台服务器上。
 *
 * 所以图床和「收口 img 的来源」是同一件事的两半，
 * 只做前一半会让第二半永远没有借口做。
 *
 * ─────────────────────────────────────────
 * 上游是 files.mrusercontent.com
 * ─────────────────────────────────────────
 *
 * 它自己给出了机器可读的接口说明（POST /agent-prompt）：
 * multipart 单传，字段名 `file`，>18MB 走三步分片。
 * 允许 image 和 video，单文件 ≤50MB。
 *
 * **访客身份是按 IP 限流的（10 分钟 20 次）**，而我们是从服务器传的 ——
 * 全站共用一个出口 IP，也就是全站每 10 分钟只能发 20 张图。
 * 所以生产必须配 API key（登录那边拿），否则第一个热闹的晚上就撞墙。
 * 没配 key 时功能照常能用，只是会撞上这个上限 —— 界面会说清楚。
 */

export const UPLOAD_ENDPOINT = "https://files.mrusercontent.com";

/**
 * 单次直传的上限。
 *
 * 上游写的是「大于 18MB 改用分片」，这里取 16MB 留一点余量：
 * multipart 的边界和头部本身也占字节，卡着 18MB 传会偶发失败，
 * 而偶发失败比稳定失败难查得多。
 */
export const SINGLE_SHOT_LIMIT = 16 * 1024 * 1024;

/** 上游的硬上限。超过这个数连分片都救不了，要在本地就拦下来 */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/**
 * 我们自己允许的类型。
 *
 * 比上游窄：上游收 image 和 video 两大类，而这里逐个列出具体格式。
 * 列白名单而不是 `startsWith("image/")` 的理由是 **SVG** ——
 * 它是 image/svg+xml，但里面可以写脚本，而一张能执行脚本的「图片」
 * 挂在自己域名下就是储存型 XSS。上游存不存是它的事，
 * 我们不产生这样的链接。
 */
export const ALLOWED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
] as const;

export type UploadKind = "image" | "video";

export function kindOf(mime: string): UploadKind | null {
  if (!(ALLOWED_TYPES as readonly string[]).includes(mime)) return null;
  return mime.startsWith("video/") ? "video" : "image";
}

export type CheckResult = { ok: true; kind: UploadKind } | { ok: false; error: string };

/**
 * 传之前先在本地判一遍。
 *
 * 不是为了替上游把关 —— 是为了**在浪费掉一次上传之前**告诉人原因。
 * 等上游回 415 再说的话，手机上传一个 40MB 的视频要等半分钟
 * 才知道格式不行。
 */
export function checkUpload(input: { mime: string; size: number }): CheckResult {
  const kind = kindOf(input.mime);
  if (!kind) {
    return { ok: false, error: `不支持这个格式（${input.mime || "未知"}）—— 图片和视频才行` };
  }
  if (input.size <= 0) return { ok: false, error: "这个文件是空的" };
  if (input.size > MAX_FILE_BYTES) {
    return {
      ok: false,
      error: `太大了（${humanSize(input.size)}），上限 ${humanSize(MAX_FILE_BYTES)}`,
    };
  }
  return { ok: true, kind };
}

export function humanSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** 要不要走分片 */
export function needsChunking(size: number): boolean {
  return size > SINGLE_SHOT_LIMIT;
}

/**
 * 第 i 片的字节区间。
 *
 * 上游的定义是 `[i*partSize, (i+1)*partSize)`，最后一片短。
 * 这一段单独抽出来是因为**差一位在这里不会报错**：
 * 传出去的文件只是少了或多了几个字节，上游照收，
 * 拿到的链接打开是一张坏图 —— 而那时候没有人会怀疑分片算错了。
 */
export function partRange(index: number, partSize: number, total: number): [number, number] {
  const start = index * partSize;
  return [start, Math.min(start + partSize, total)];
}

export function partCount(total: number, partSize: number): number {
  return Math.ceil(total / partSize);
}

/**
 * 上游的错误码翻成人话。
 *
 * 直接把 502 甩给用户，他只会再点一次；而这里每一句都告诉他
 * **下一步该做什么**。
 */
export function explainUpstream(status: number, raw?: string): string {
  switch (status) {
    case 401:
      return "图床拒绝了这次上传（认证无效）—— 这是站点配置的问题，不是你的";
    case 413:
      return "图床说这个文件太大了";
    case 415:
      return "图床不收这个格式";
    case 429:
      return "传得太密了，等一会儿再试 —— 图床那边在限速";
    case 502:
      return "图床后面的存储出了点问题，再试一次多半就好";
    default:
      return raw?.trim() ? `图床返回了 ${status}：${raw.slice(0, 120)}` : `图床返回了 ${status}`;
  }
}

/**
 * 插进正文里的那段 markdown。
 *
 * 视频不能用 `![]()` —— markdown 的图片语法渲染出来是 `<img>`，
 * 而 `<img src="x.mp4">` 是一个破图标。视频给一条普通链接，
 * 至少点得开。
 *
 * alt 用文件名而不是留空：留空的话读屏软件只会念一句「图像」，
 * 而文件名多半带着一点信息。但要清掉可能破坏 markdown 的字符。
 */
export function markdownFor(kind: UploadKind, url: string, filename: string): string {
  const alt = filename.replace(/[[\]()\\]/g, "").trim().slice(0, 80) || "图片";
  return kind === "video" ? `[${alt}](${url})` : `![${alt}](${url})`;
}

/**
 * 上游返回里该用哪个链接。
 *
 * 接口说明写得很明确：用 `url`，**除非另有要求否则不要用 `cdn_url`**。
 * 照着做 —— 一个自己贴心地换成 CDN 的实现，会在 CDN 出问题那天
 * 让所有历史帖子里的图一起坏掉，而链接已经写进正文了，改不回来。
 */
export function pickUrl(payload: { url?: unknown; origin_url?: unknown }): string | null {
  const url = typeof payload.url === "string" ? payload.url : null;
  const fallback = typeof payload.origin_url === "string" ? payload.origin_url : null;
  const picked = url ?? fallback;
  if (!picked) return null;
  // 只接受 https 的绝对地址 —— 相对地址会被当成本站路径，http 会在页面上引出混合内容警告
  return /^https:\/\//.test(picked) ? picked : null;
}
