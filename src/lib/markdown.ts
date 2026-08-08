import "server-only";

import DOMPurify from "isomorphic-dompurify";
import { Marked } from "marked";
import { codeToHtml } from "shiki";

/**
 * Markdown 渲染管线。
 *
 * **这是论坛最容易出 XSS 的地方。** 原则：
 *   1. 允许清单，不是拦截黑名单 —— 黑名单永远追不上新的绕过方式
 *   2. 渲染在服务端做一次，存 HTML；客户端永远不执行 markdown 解析
 *   3. 消毒是最后一道且不可跳过，连我们自己生成的 HTML 也要过一遍
 *
 * 用户内容里的裸 HTML 一律不解析（marked 的 sanitize 已废弃，
 * 所以靠 DOMPurify 兜底而不是靠解析器）。
 */

const marked = new Marked({
  gfm: true,
  breaks: true, // 群友习惯换行即分段，不强求写两个空格
});

/** 允许的标签。没列出来的一律剥掉 */
const ALLOWED_TAGS = [
  "p", "br", "hr",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "strong", "em", "del", "s", "mark", "sub", "sup",
  "blockquote", "ul", "ol", "li",
  "a", "img",
  "code", "pre", "span",
  "table", "thead", "tbody", "tr", "th", "td",
  "details", "summary",
];

const ALLOWED_ATTR = [
  "href", "title", "alt", "src", "loading", "width", "height",
  "class", "style", "id",
  "colspan", "rowspan",
  "data-lang", "data-mention", "data-footnote",
  "open",
];

/**
 * style 属性只放行 shiki 生成的配色。
 * 全放开的话可以用 position:fixed 覆盖整页做钓鱼，
 * 用 background:url() 探测访问者。
 */
const SAFE_STYLE_PATTERN = /^(color|background-color|font-style|font-weight|text-decoration)\s*:\s*[#a-zA-Z0-9(),.\s%-]+;?\s*$/;

let purifyConfigured = false;

function configurePurify() {
  if (purifyConfigured) return;

  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    // 站外链接一律新窗口打开，并切断 window.opener 反向控制
    if (node.tagName === "A") {
      const href = node.getAttribute("href") ?? "";
      const external = /^https?:\/\//i.test(href) && !href.includes("agenticlab.sh");
      if (external) {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer nofollow ugc");
      }
    }

    if (node.tagName === "IMG") {
      node.setAttribute("loading", "lazy");
      node.setAttribute("decoding", "async");
    }

    // 逐条校验 style，不合规就整个删掉
    const style = node.getAttribute?.("style");
    if (style) {
      const safe = style
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean)
        .every((decl) => SAFE_STYLE_PATTERN.test(`${decl};`));
      if (!safe) node.removeAttribute("style");
    }
  });

  purifyConfigured = true;
}

export function sanitizeHtml(html: string): string {
  configurePurify();
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    // javascript: data: 之类的伪协议一律拒绝；data: 只在图片里另行判断
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#|\/(?!\/))/i,
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "input", "textarea"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "formaction", "srcset"],
    KEEP_CONTENT: true,
  });
}

/** 代码块用 shiki 高亮；语言认不出就退回纯文本，不报错 */
async function highlight(code: string, lang: string | undefined): Promise<string> {
  const language = (lang ?? "").trim().toLowerCase() || "text";
  try {
    return await codeToHtml(code, {
      lang: language,
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
    });
  } catch {
    // 未知语言不该让整篇帖子渲染失败
    return await codeToHtml(code, {
      lang: "text",
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
    });
  }
}

export interface RenderResult {
  html: string;
  excerpt: string;
  mentions: string[];
}

/** @提及。只认字母数字下划线中文，避免把邮箱地址整个吞掉 */
const MENTION_PATTERN = /(^|[\s(（【])@([A-Za-z0-9_一-龥-]{1,32})/g;

export async function renderMarkdown(
  source: string,
  options: { resolveMention?: (name: string) => string | null } = {},
): Promise<RenderResult> {
  const mentions: string[] = [];

  /*
   * 代码块要先摘出来，原因有两个：
   *   1. 代码里全是 @（装饰器、注解、邮件地址），不摘出来会误判成提及
   *   2. shiki 的高亮结果是 HTML，塞回 markdown 会被再解析一次
   *
   * 占位符带随机后缀 —— 固定字符串的话，用户在正文里原样写出来
   * 就能把自己的文字替换成别人的代码块。
   */
  const token = `XCODE${Math.random().toString(36).slice(2, 10).toUpperCase()}X`;
  const codeBlocks: { code: string; lang?: string; inline: boolean }[] = [];

  const withoutCode = source.replace(
    /```(\w*)\n?([\s\S]*?)```|`([^`\n]*)`/g,
    (_match, lang, block, inline) => {
      if (inline !== undefined) {
        codeBlocks.push({ code: inline, inline: true });
      } else {
        codeBlocks.push({ code: block ?? "", lang: lang || undefined, inline: false });
      }
      return `${token}${codeBlocks.length - 1}${token}`;
    },
  );

  const withMentions = withoutCode.replace(MENTION_PATTERN, (match, prefix, name) => {
    const resolved = options.resolveMention?.(name);
    if (!resolved) return match;
    mentions.push(resolved);
    return `${prefix}[@${name}](/u/${encodeURIComponent(resolved)})`;
  });

  const rendered = await marked.parse(withMentions, { async: true });

  // 回填代码块。放在消毒**之前**，让 shiki 的输出也过一遍消毒
  let withCode = rendered;
  for (let i = 0; i < codeBlocks.length; i++) {
    const entry = codeBlocks[i];
    const replacement = entry.inline
      ? `<code>${escapeHtml(entry.code)}</code>`
      : await highlight(entry.code.replace(/\n$/, ""), entry.lang);
    // 块级代码会被 markdown 包进 <p>，一起换掉，避免出现 p 里嵌 pre
    withCode = withCode
      .replace(`<p>${token}${i}${token}</p>`, replacement)
      .replace(`${token}${i}${token}`, replacement);
  }

  return {
    html: sanitizeHtml(withCode),
    excerpt: makeExcerpt(source),
    mentions: [...new Set(mentions)],
  };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 列表页用的纯文本摘要。剥掉所有标记，不是截断 HTML */
export function makeExcerpt(source: string, length = 140): string {
  const plain = source
    .replace(/```[\s\S]*?```/g, " [代码] ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " [图片] ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#*_>`~|-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > length ? `${plain.slice(0, length)}…` : plain;
}
