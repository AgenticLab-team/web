import "server-only";

import { codeToHtml } from "shiki";

import { sanitizeHtml } from "@/lib/markdown";

/**
 * 把取回来的代码片段高亮成 HTML。
 *
 * ═════════════════════════════════════════
 * 为什么在**取回来的那一刻**做，而不是渲染时
 * ═════════════════════════════════════════
 *
 * 帖子底下的卡片有一条铁律：数字不能烤进去（`★ 1.2k` 会停在发帖那天）。
 * 代码片段是那条规则的**例外，而且是有据可依的例外** ——
 * 解析层只认带 40 位 sha 的代码链接，一个 sha 指向的内容不可能变。
 *
 * 既然结果永远相同，就没有理由让每一个读者的那次打开都重跑一遍
 * 高亮：shiki 要加载语法定义和主题，那是实打实的 CPU。
 * 补缓存的定时任务一年跑一次这段，读的人一次都不跑。
 *
 * ═════════════════════════════════════════
 * 仍然要过消毒
 * ═════════════════════════════════════════
 *
 * 「连我们自己生成的 HTML 也要消毒」是 markdown 那条管线上写着的原则，
 * 这里不给它开口子 —— 而且这段 HTML 的原料来自**别人的仓库**，
 * 比我们自己的输出更没有理由信任。
 *
 * 走的是同一个 `sanitizeHtml`，不是另写一份白名单：另写一份的话，
 * 哪天那边补了一条规则，这边不会跟着补。
 */
export async function highlightSnippet(code: string, lang: string): Promise<string> {
  let html: string;
  try {
    html = await codeToHtml(code, {
      lang,
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
    });
  } catch {
    // 语言认不出来不该让整块消失 —— 退回纯文本，颜色没了，代码还在
    html = await codeToHtml(code, {
      lang: "text",
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
    });
  }
  return sanitizeHtml(html);
}
