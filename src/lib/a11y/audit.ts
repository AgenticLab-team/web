/**
 * 无障碍走查。纯函数，输入是 JSX 源码文本。
 *
 * ─────────────────────────────────────────
 * 为什么做成测试而不是一次性走查
 * ─────────────────────────────────────────
 *
 * 一次性走查会**衰减**：这周改干净了，下周新加一个图标按钮又没有 aria-label，
 * 而没有人会再走查第二遍。无障碍问题的特点是**做的人看不见** ——
 * 用鼠标的人永远不会发现某个按钮读屏时念作「按钮」。
 *
 * 所以规则写成可执行的，跟着每次 `npm test` 跑。
 *
 * ─────────────────────────────────────────
 * 只查百分之百确定的
 * ─────────────────────────────────────────
 *
 * 正则解析 JSX 一定不完备。这里的取舍是**宁可漏报，不可误报** ——
 * 一个会误报的检查，第一次挡住正常提交时就会被人加上豁免注释，
 * 第二次就会被删掉。漏报只是少查一点，误报会让整条规则消失。
 */

export interface Finding {
  rule: string;
  detail: string;
  /** 触发的那段源码，方便定位 */
  snippet: string;
  line: number;
}

/** 从 `<tag` 开始，找到这个开标签结束的位置（跳过字符串与花括号） */
function endOfOpenTag(source: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;

  for (let i = start; i < source.length; i++) {
    const char = source[i];

    if (quote) {
      if (char === quote && source[i - 1] !== "\\") quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth++;
    else if (char === "}") depth--;
    else if (char === ">" && depth === 0) return i;
  }
  return source.length;
}

/** 找到与开标签配对的闭合标签位置（处理同名嵌套） */
function endOfElement(source: string, tag: string, openEnd: number): number {
  if (source[openEnd - 1] === "/") return openEnd; // 自闭合

  const open = new RegExp(`<${tag}[\\s>]`, "g");
  const close = new RegExp(`</${tag}\\s*>`, "g");
  let depth = 1;
  let cursor = openEnd + 1;

  while (cursor < source.length) {
    open.lastIndex = cursor;
    close.lastIndex = cursor;
    const nextOpen = open.exec(source);
    const nextClose = close.exec(source);
    if (!nextClose) return source.length;

    if (nextOpen && nextOpen.index < nextClose.index) {
      depth++;
      cursor = nextOpen.index + 1;
    } else {
      depth--;
      if (depth === 0) return nextClose.index;
      cursor = nextClose.index + 1;
    }
  }
  return source.length;
}

export interface Element {
  tag: string;
  /** 开标签里的属性文本 */
  attrs: string;
  /** 元素内部的内容（自闭合时为空） */
  body: string;
  index: number;
  line: number;
}

export function findElements(source: string, tag: string): Element[] {
  const out: Element[] = [];
  const opener = new RegExp(`<${tag}(?=[\\s/>])`, "g");

  for (const match of source.matchAll(opener)) {
    const start = match.index ?? 0;
    const openEnd = endOfOpenTag(source, start);
    const bodyEnd = endOfElement(source, tag, openEnd);

    out.push({
      tag,
      attrs: source.slice(start + tag.length + 1, openEnd),
      body: source[openEnd - 1] === "/" ? "" : source.slice(openEnd + 1, bodyEnd),
      index: start,
      line: source.slice(0, start).split("\n").length,
    });
  }
  return out;
}

export function hasAttr(attrs: string, name: string): boolean {
  return new RegExp(`(^|\\s)${name}(=|\\s|$)`).test(attrs);
}

/**
 * 这个元素**确定**没有可读的名字吗。
 *
 * 判据故意定得很窄：内容里除了元素标签和空白之外**什么都没有**。
 *
 * 第一版写成「有没有文字」，结果 `<button>{tab.label}</button>`
 * 这种再正常不过的写法被报了十五条 —— 名字在运行时才存在，
 * 静态看不出来。而**一个会误报的检查，第一次挡住正常提交时
 * 就会被加上豁免注释，第二次就会被删掉**。
 *
 * 所以只要出现任何 `{...}` 表达式，就当它可能是名字，不报。
 * 漏掉几个是可以接受的代价，规则本身活下来更重要。
 */
export function isNameless(body: string): boolean {
  const withoutElements = body.replace(/<[^>]*>/g, " ");
  // 有任何表达式就无法静态判断 —— 不报
  if (/\{/.test(withoutElements)) return false;
  return !/[\p{L}\p{N}]/u.test(withoutElements);
}

/** 带 `label=` 属性的大写组件 —— 视作一个已经带标签的字段包裹 */
export function componentsWithLabelProp(source: string): Element[] {
  const names = new Set(
    [...source.matchAll(/<([A-Z]\w*)\s[^>]*?\blabel=/g)].map((m) => m[1]),
  );
  return [...names].flatMap((name) =>
    findElements(source, name).filter((e) => hasAttr(e.attrs, "label")),
  );
}

// ── 规则 ────────────────────────────────────────────────────

type Rule = (source: string) => Finding[];

const snippetOf = (element: Element) =>
  `<${element.tag}${element.attrs}>`.replace(/\s+/g, " ").slice(0, 110);

/**
 * 只有图标的按钮必须有 aria-label。
 *
 * 读屏念到一个没有名字的按钮时只会说「按钮」——
 * 而一排「按钮、按钮、按钮」和一个空白页面没有区别。
 */
const iconOnlyButtonNeedsLabel: Rule = (source) => {
  const findings: Finding[] = [];
  for (const element of findElements(source, "button")) {
    if (hasAttr(element.attrs, "aria-label") || hasAttr(element.attrs, "aria-labelledby")) continue;
    if (!isNameless(element.body)) continue;
    findings.push({
      rule: "button-name",
      detail: "只有图标的按钮没有 aria-label —— 读屏只会念「按钮」",
      snippet: snippetOf(element),
      line: element.line,
    });
  }
  return findings;
};

/** 只有图标的链接同理 */
const iconOnlyLinkNeedsLabel: Rule = (source) => {
  const findings: Finding[] = [];
  for (const tag of ["a", "Link"]) {
    for (const element of findElements(source, tag)) {
      if (hasAttr(element.attrs, "aria-label") || hasAttr(element.attrs, "aria-labelledby")) continue;
      if (!isNameless(element.body)) continue;
      findings.push({
        rule: "link-name",
        detail: "只有图标的链接没有 aria-label",
        snippet: snippetOf(element),
        line: element.line,
      });
    }
  }
  return findings;
};

/** 图片必须有 alt（装饰性的写 alt=""） */
const imgNeedsAlt: Rule = (source) =>
  findElements(source, "img")
    .filter((e) => !hasAttr(e.attrs, "alt"))
    .map((e) => ({
      rule: "img-alt",
      detail: "图片没有 alt —— 装饰性的也要写 alt=\"\"",
      snippet: snippetOf(e),
      line: e.line,
    }));

/**
 * `role="switch"` 必须带 `aria-checked`。
 *
 * 少了它，读屏知道这是个开关但不知道**现在是开还是关** ——
 * 而开关这种控件，状态就是它的全部信息。
 */
const switchNeedsChecked: Rule = (source) => {
  const findings: Finding[] = [];
  for (const tag of ["button", "div", "span"]) {
    for (const element of findElements(source, tag)) {
      if (!/role=["']switch["']/.test(element.attrs)) continue;
      if (hasAttr(element.attrs, "aria-checked")) continue;
      findings.push({
        rule: "switch-checked",
        detail: "role=\"switch\" 没有 aria-checked —— 读屏不知道现在是开还是关",
        snippet: snippetOf(element),
        line: element.line,
      });
    }
  }
  return findings;
};

/**
 * 输入框要有名字。
 *
 * placeholder 也算 —— 它不是最好的做法，但在这个项目里到处都是，
 * 一刀切要求 label 会产出上百条误报，而误报会让整条规则被删掉。
 * 真正要挡的是**一个既没有 label 也没有 placeholder 的框**。
 */
const inputNeedsName: Rule = (source) => {
  const findings: Finding[] = [];

  /*
   * 两种「已经有名字了」的包裹要认出来，否则会误报一大片：
   *
   *   ① <label><input/>说明文字</label> —— 项目里所有复选框都是这个写法
   *   ② <Field label="名称"><input/></Field> —— 组件把 label 包在里面，
   *      而组件定义在文件的另一处，静态跟不过去
   *
   * 第二种是第一版漏掉的：BoardEditor 里四个规规矩矩带标签的输入框
   * 全被报了出来。误报会让整条规则被删掉，所以宁可把「带 label 属性的
   * 大写组件」一律当成有名字。
   */
  /*
   * ⚠️ 空的 `<label>` **不算**有名字，而且比不包更糟。
   *
   * 名字的算法是：外层 label 一旦存在，名字就由它的文字内容决定，
   * 而 placeholder 的兜底**只在没有 label 时**才轮得到。
   * 所以一个只包着图标的 label 会给出一个空名字，并且把 placeholder
   * 挡在外面 —— 读屏念到那个框只说「编辑框」。
   *
   * 这一条是踩出来的：搜索框外层为了扩大命中区从 `<div>` 换成
   * `<label>`，视觉上一个像素没动，静态这条规则也照旧放行
   * （「它在 label 里」），而运行时的无障碍树上那个框失去了名字。
   * 是把 AX 树拉出来才看见的（`scripts/ax-audit.mjs`）。
   *
   * 所以只有**带文字的** label 才算数：把标签里的元素剥掉之后
   * 还剩下非空白字符，才说明读屏念得出东西。
   */
  const hasText = (body: string) => body.replace(/<[^>]*>/g, "").replace(/\{[^}]*\}/g, "").trim().length > 0;
  const wrapped: [number, number][] = [
    ...findElements(source, "label").filter((l) => hasText(l.body)),
    ...componentsWithLabelProp(source),
  ].map((l) => [l.index, l.index + l.attrs.length + l.body.length + 16]);
  const insideLabel = (index: number) => wrapped.some(([from, to]) => index > from && index < to);

  for (const element of findElements(source, "input")) {
    if (/type=["'](hidden|submit|button)["']/.test(element.attrs)) continue;
    if (insideLabel(element.index)) continue;
    if (
      hasAttr(element.attrs, "aria-label") ||
      hasAttr(element.attrs, "aria-labelledby") ||
      hasAttr(element.attrs, "placeholder") ||
      hasAttr(element.attrs, "id")
    ) {
      continue;
    }
    findings.push({
      rule: "input-name",
      detail: "输入框既没有 label 也没有 placeholder —— 读屏念不出它是干什么的",
      snippet: snippetOf(element),
      line: element.line,
    });
  }
  return findings;
};

/**
 * `target="_blank"` 必须带 `rel="noopener"`。
 *
 * 不是无障碍问题，是安全问题：被打开的页面能通过 `window.opener`
 * 把原标签页导航走。放在同一次走查里，因为它们都属于
 * 「写的人看不见、用的人也不会来报」的那一类。
 */
const blankNeedsNoopener: Rule = (source) =>
  findElements(source, "a")
    .filter((e) => /target=["']_blank["']/.test(e.attrs) && !/rel=["'][^"']*noopener/.test(e.attrs))
    .map((e) => ({
      rule: "blank-noopener",
      detail: 'target="_blank" 没有 rel="noopener" —— 新页面能把原标签页导航走',
      snippet: snippetOf(e),
      line: e.line,
    }));

/**
 * 装饰性图标要 `aria-hidden`。
 *
 * 不加的话读屏会念出图标组件名或者一串空内容，
 * 把一句话切得七零八落。这条只查**明确带 lucide 图标类名**的用法，
 * 避免误伤。
 */
const decorativeIconHidden: Rule = (source) => {
  const findings: Finding[] = [];
  // <SomeIcon className="h-4 w-4" strokeWidth={2} /> 这类自闭合调用
  const iconTag = /<([A-Z]\w*)\s([^>]*?)\/>/g;
  for (const match of source.matchAll(iconTag)) {
    const [, name, attrs] = match;
    if (!/className=["'][^"']*\bh-\d/.test(attrs)) continue; // 只看有尺寸类名的
    if (!/strokeWidth/.test(attrs)) continue; // lucide 的标志
    if (/aria-hidden|aria-label|role=/.test(attrs)) continue;
    findings.push({
      rule: "icon-hidden",
      detail: `<${name}> 是装饰性图标但没有 aria-hidden —— 读屏会把句子念碎`,
      snippet: match[0].replace(/\s+/g, " ").slice(0, 110),
      line: source.slice(0, match.index ?? 0).split("\n").length,
    });
  }
  return findings;
};

/**
 * 图标按钮的可点范围要够大。
 *
 * 一个 28px 的删除按钮在设计稿上很克制，在手机上是每三次点中两次 ——
 * 而点不中的人不会来报 bug，他只会觉得这个站有点难用。
 *
 * 判据只看**明确写小了**的情况：`p-0.5` / `p-1` / `p-1.5` 这类
 * 内边距很小、又没有 `tap-target` 也没有显式高度的按钮。
 * 拿不准的一律不报 —— 误报会让整条规则被删掉。
 */
const smallIconButtonNeedsTapTarget: Rule = (source) => {
  const findings: Finding[] = [];
  for (const element of findElements(source, "button")) {
    if (!isNameless(element.body)) continue; // 有文字的按钮本来就够大
    const className = element.attrs.match(/className=\{?["'`]([^"'`]*)["'`]/)?.[1] ?? "";
    if (!/\bp-(0\.5|1|1\.5|2)\b/.test(className)) continue;
    if (/\btap-target\b/.test(className)) continue;
    if (/\b(h|min-h)-(11|12|14|16)\b/.test(className)) continue;
    findings.push({
      rule: "tap-target",
      detail: "图标按钮的可点范围可能不到 44px —— 加 tap-target 类（视觉尺寸不变）",
      snippet: snippetOf(element),
      line: element.line,
    });
  }
  return findings;
};

export const RULES: Record<string, Rule> = {
  "tap-target": smallIconButtonNeedsTapTarget,
  "button-name": iconOnlyButtonNeedsLabel,
  "link-name": iconOnlyLinkNeedsLabel,
  "img-alt": imgNeedsAlt,
  "switch-checked": switchNeedsChecked,
  "input-name": inputNeedsName,
  "blank-noopener": blankNeedsNoopener,
  "icon-hidden": decorativeIconHidden,
};

/**
 * 把注释挖空，但**保留每一个换行**。
 *
 * ─────────────────────────────────────────
 * 不挖的话，说明文字会被当成真的标记
 * ─────────────────────────────────────────
 *
 * 这是真撞上的：DayNav 的文件头注释里写了一句
 * 「原生 `<input type="date">` + GET 表单」，用来解释为什么不自己搓日历。
 * 扫描器把那行当成一个没有 label 的输入框报了出来 ——
 * 而那一行根本不是代码。
 *
 * 误报比漏报更伤这类检查：一条查出来是假的之后，
 * 下一条真的也会被顺手划掉。
 *
 * 换行必须保留，否则报出来的行号会往前串，
 * 而**指错行的报告等于没有行号**。
 */
function blankComments(source: string): string {
  const keepNewlines = (m: string) => m.replace(/[^\n]/g, " ");
  return source
    .replace(/\/\*[\s\S]*?\*\//g, keepNewlines)
    .replace(/\/\/[^\n]*/g, keepNewlines);
}

export function auditSource(source: string): Finding[] {
  const code = blankComments(source);
  return Object.values(RULES).flatMap((rule) => rule(code));
}
