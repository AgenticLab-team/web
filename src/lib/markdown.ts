import "server-only";

import DOMPurify from "isomorphic-dompurify";
import { Marked } from "marked";
import { codeToHtml } from "shiki";

import { linkifyGithubShorthand } from "@/lib/github/shorthand";
import { isAllowedImageSource } from "@/lib/image-sources";

import {
  MATHML_ATTRS,
  MATHML_TAGS,
  MATH_TOKEN_PREFIX,
  extractMath,
  renderMath,
} from "./markdown-math";

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
  // 数学公式（MathML）。走 MathML 而不是 KaTeX 的带样式 span ——
  // 理由见 markdown-math.ts：那条路要为它放宽 style 白名单
  ...MATHML_TAGS,
];

const ALLOWED_ATTR = [
  "href", "title", "alt", "src", "loading", "width", "height",
  "class", "style", "id",
  "colspan", "rowspan",
  "data-lang", "data-mention", "data-footnote",
  "open",
  ...MATHML_ATTRS,
];

/**
 * style 属性只放行 shiki 生成的配色。
 * 全放开的话可以用 position:fixed 覆盖整页做钓鱼，
 * 用 background:url() 探测访问者。
 *
 * ─────────────────────────────────────────
 * `--shiki-*` 也得放行，否则这条规则把高亮整个删干净
 * ─────────────────────────────────────────
 *
 * 这里原来只列了 `color` / `background-color` 那几个属性名，
 * 而 shiki 在双主题模式（`defaultColor: false`）下**一个都不写** ——
 * 它写的是 `--shiki-light:#D73A49;--shiki-dark:#F97583`
 * 这样的自定义属性，再由 globals.css 里 `.prose-forum .shiki`
 * 那几条规则 `var()` 出来。
 *
 * 于是每一条声明都不匹配、整个 style 属性被删掉，
 * **全站每一个代码块都是没有颜色的** —— 而 `.shiki` 那个类名
 * 还在，CSS 也还在，看源码完全看不出哪里断了。
 * 这正是这个仓库最常见的那种失败：看起来在工作、其实什么都没发生。
 *
 * 放行它们是安全的，理由不是「它长得像 shiki」：
 * 自定义属性本身不影响任何渲染，只有 CSS 里显式 `var()` 它的地方
 * 才会取到值 —— 而站里 `var(--shiki-*)` 只出现在 color 和
 * background-color 上。值的字符集照旧受下面那段限制
 * （没有 `:`、`;`、引号、斜杠，拼不出 url("//…")）。
 */
const SAFE_STYLE_PATTERN =
  /^(color|background-color|font-style|font-weight|text-decoration|--shiki-(?:light|dark)(?:-bg)?)\s*:\s*[#a-zA-Z0-9(),.\s%-]+;?\s*$/;

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
      /*
       * ─────────────────────────────────────────
       * 图片的来源必须收口
       * ─────────────────────────────────────────
       *
       * `img` 一直是放行标签，而 `src` 一直没有白名单 ——
       * 也就是说任何人都可以在帖子里放一张**指向自己服务器的图**，
       * 而每一个打开这篇帖子的人，浏览器都会自动去请求它一次。
       *
       * 一张 1×1 的透明图就足够把「谁、在什么时候、用什么设备
       * 读了这篇」连同 IP 一起送到那台服务器上。读者不会点任何东西，
       * 也不会看到任何异样。**在一个把隐私当卖点的站上，
       * 这是最安静的那种泄露。**
       *
       * 所以只放行自己的图床和头像那几个域名。别的**不是删掉，
       * 是降级成一条链接** —— 删掉会让人以为帖子坏了，
       * 而链接把「要不要去访问那台服务器」这个决定还给读者本人。
       * 这和新人外链降权是同一条思路。
       */
      const src = node.getAttribute("src") ?? "";
      if (!isAllowedImageSource(src)) {
        const link = node.ownerDocument.createElement("a");
        link.setAttribute("href", src);
        link.setAttribute("target", "_blank");
        link.setAttribute("rel", "noopener noreferrer nofollow ugc");
        // 说清楚发生了什么，否则作者会以为自己的图挂了
        const alt = node.getAttribute("alt")?.trim();
        link.textContent = alt ? `🖼 ${alt}（站外图片，点开查看）` : "🖼 站外图片（点开查看）";
        node.parentNode?.replaceChild(link, node);
        return;
      }

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

  /*
   * 公式也要在 markdown 解析**之前**摘出来，理由和代码块一样：
   * `a_1 * b_2` 里的 `_` 和 `*` 会被解析成下标和强调，`\\` 会被吃掉。
   *
   * 摘在代码块**之后** —— 代码里写 `$100` 的概率比正文里高得多，
   * 而那时候它已经被换成占位符了，扫不到。
   */
  const mathToken = `${MATH_TOKEN_PREFIX}${Math.random().toString(36).slice(2, 10).toUpperCase()}X`;
  const { text: withoutMath, pieces: mathPieces } = extractMath(withoutCode, mathToken);

  /*
   * `owner/repo#123` 的简写在这里变成普通的 markdown 链接。
   *
   * 位置很要紧：**代码块和公式已经被换成占位符了**，所以代码里的
   * 路径和注解不会被误伤；而它又在 marked 解析之前，产出的链接
   * 走的是和别的链接完全一样的消毒与 rel 处理 —— 不额外开口子。
   */
  const withShorthand = linkifyGithubShorthand(withoutMath);

  const withMentions = withShorthand.replace(MENTION_PATTERN, (match, prefix, name) => {
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

  /*
   * 回填公式。同样放在消毒**之前** —— KaTeX 的输出也要过一遍，
   * 「连我们自己生成的 HTML 也要消毒」那条原则不给任何东西开口子。
   */
  let withMath = withCode;
  for (let i = 0; i < mathPieces.length; i++) {
    const replacement = renderMath(mathPieces[i]);
    // 块级公式会被 markdown 包进 <p>，一起换掉，免得 p 里嵌 div
    withMath = withMath
      .replace(`<p>${mathToken}${i}${mathToken}</p>`, replacement)
      .replace(`${mathToken}${i}${mathToken}`, replacement);
  }

  return {
    html: sanitizeHtml(withMath),
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
    // 公式在摘要里只留一个词 —— 一串 \frac{}{} 在列表里既占地方又读不懂
    .replace(/\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]/g, " [公式] ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " [图片] ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#*_>`~|-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > length ? `${plain.slice(0, length)}…` : plain;
}
