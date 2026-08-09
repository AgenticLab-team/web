/**
 * 预览态写入拦截的覆盖检查。纯函数，输入是源码文本。
 *
 * ─────────────────────────────────────────
 * 为什么不能只在一个地方拦
 * ─────────────────────────────────────────
 *
 * 最想做的是把拦截放进 requireAdmin —— 88 个调用点一次覆盖完。
 * 但 requireAdmin 同时服务**页面读取**和**写操作**：
 * 一刀切地拦下来，预览一个版主时后台页面全都跳走，
 * 而「版主进后台能看到哪几项」恰恰是这个功能要回答的问题之一。
 *
 * 所以只能逐个拦写操作。而逐个拦就意味着会漏 ——
 * 除非有东西在检查。
 *
 * 判据和审计覆盖那个检查器是同一套：调了 requireAdmin 又做了写操作
 * 的函数，必须调 assertNotPreviewing()。
 *
 * ─────────────────────────────────────────
 * 漏一个的后果
 * ─────────────────────────────────────────
 *
 * 管理员以别人的身份写了数据，而审计日志记的是**被预览的那个人**。
 * 这不只是记错一条 —— 是从此以后这个站的审计日志一条都不能信，
 * 因为你无法区分「他真的做了」和「有人以他的身份做了」。
 */

import { hasWrite, requiresAdmin, splitFunctions } from "./coverage";

export interface PreviewGap {
  file: string;
  fn: string;
  line: number;
  reason: string;
}

const GUARD = /\bassertNotPreviewing\(/;

/**
 * 委托出去的：这些函数自己会拦。
 *
 * 和审计那张表一样，写错名字等于发永久豁免，
 * 所以 tests/preview-coverage.test.ts 会核对名字真的存在且真的会拦。
 */
export const PREVIEW_DELEGATES = ["requireWritableAdmin"] as const;

export function delegatesGuard(body: string): string | null {
  for (const name of PREVIEW_DELEGATES) {
    if (new RegExp(`\\b${name}\\(`).test(body)) return name;
  }
  return null;
}

/**
 * 不需要拦的。
 *
 * **只有一类东西配进来是对的：预览态本身的进出。**
 * 退出预览是个写操作（要把这一行标成结束），而它当然发生在预览态里 ——
 * 拦住它人就永远出不去了。
 */
export const PREVIEW_EXEMPT = new Set(["exitPreviewAction", "startPreviewAction"]);

export function previewGaps(file: string, source: string): PreviewGap[] {
  const gaps: PreviewGap[] = [];

  for (const fn of splitFunctions(source)) {
    if (!requiresAdmin(fn.body)) continue;
    if (PREVIEW_EXEMPT.has(fn.name)) continue;
    if (!hasWrite(fn.body)) continue;
    if (GUARD.test(fn.body)) continue;
    if (delegatesGuard(fn.body)) continue;

    gaps.push({
      file,
      fn: fn.name,
      line: fn.line,
      reason: "调了 requireAdmin 又做了写操作，但没有 assertNotPreviewing()",
    });
  }

  return gaps;
}
