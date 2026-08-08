/**
 * 敏感词匹配。纯函数，不碰数据库。
 *
 * ─────────────────────────────────────────
 * 为什么不能直接 content.includes(word)
 * ─────────────────────────────────────────
 *
 * 规避成本太低了：加个空格、换成全角、中间插个标点，就绕过去了。
 * 所以匹配前要先**归一化**：去掉空白与标点、全角转半角、统一小写。
 *
 * 但归一化会打乱下标，而替换和高亮都需要**原文的位置**。
 * 所以归一化时同步记一张下标映射表，匹配在归一化空间里做，
 * 结果映射回原文。少了这张表，替换就只能整段重写，
 * 那会把用户的排版和标点全毁掉。
 *
 * ─────────────────────────────────────────
 * 比漏判更该怕的是误伤
 * ─────────────────────────────────────────
 *
 * 子串匹配必然误伤：一个两字的词能在无数正常表达里出现。
 * 所以：
 *   - 默认档位是**送审**而不是拦截。拦截的代价是有人的内容直接没了，
 *     而他往往不知道为什么，也没处说理
 *   - 词长有下限。一个字的词几乎匹配一切，加进去就是灾难
 *   - 每条规则记命中次数，命中特别多的大概率是误伤，后台要能看见
 */

export type WordKind = "block" | "review" | "replace";

export interface WordRule {
  id: string;
  word: string;
  kind: WordKind;
  replacement: string | null;
  enabled: boolean;
}

export interface WordHit {
  ruleId: string;
  word: string;
  kind: WordKind;
  replacement: string | null;
  /** 原文中的位置，用于高亮与替换 */
  start: number;
  end: number;
  /** 命中的原文片段（可能带着被归一化掉的空格标点） */
  matched: string;
}

export type WordVerdict = "pass" | "review" | "block";

export interface ScanResult {
  verdict: WordVerdict;
  hits: WordHit[];
  /** 应用替换之后的文本。没有替换类命中时与原文相同 */
  replaced: string;
  /** 触发拦截或送审的规则，用于给管理员看 */
  triggeredBy: WordHit[];
}

/** 词长下限。一个字的词几乎匹配一切 */
export const MIN_WORD_LENGTH = 2;

interface Normalized {
  text: string;
  /** 归一化后第 i 个字符来自原文的哪个下标 */
  map: number[];
}

/**
 * 归一化。
 *
 * 丢掉空白、标点、零宽字符 —— 这三类是最常见的规避手段。
 * 全角转半角，英文统一小写。
 */
function normalize(input: string): Normalized {
  const chars: string[] = [];
  const map: number[] = [];

  for (let i = 0; i < input.length; i++) {
    const code = input.codePointAt(i)!;
    const ch = String.fromCodePoint(code);
    // 代理对要整体前进，否则会把一个 emoji 拆成两半
    const width = code > 0xffff ? 2 : 1;

    if (!isSkippable(ch)) {
      chars.push(fold(ch));
      map.push(i);
    }
    i += width - 1;
  }

  return { text: chars.join(""), map };
}

/** 空白、标点、零宽字符一律跳过 */
function isSkippable(ch: string): boolean {
  return /[\s\p{P}\p{S}​-‏﻿]/u.test(ch);
}

/** 全角转半角 + 小写 */
function fold(ch: string): string {
  const code = ch.charCodeAt(0);
  if (code >= 0xff01 && code <= 0xff5e) {
    return String.fromCharCode(code - 0xfee0).toLowerCase();
  }
  // 全角空格已经被 isSkippable 拦掉了
  return ch.toLowerCase();
}

/**
 * 扫描一段文本。
 *
 * 档位优先级：拦截 > 送审 > 替换。
 * 一段话同时命中拦截和替换时结论是拦截 —— 替换的结果不该被发出去。
 */
export function scanText(text: string, rules: readonly WordRule[]): ScanResult {
  const active = rules.filter((r) => r.enabled && r.word.trim().length > 0);
  if (active.length === 0 || !text) {
    return { verdict: "pass", hits: [], replaced: text, triggeredBy: [] };
  }

  const source = normalize(text);
  const hits: WordHit[] = [];

  for (const rule of active) {
    const needle = normalize(rule.word).text;
    if (needle.length === 0) continue;

    let from = 0;
    for (;;) {
      const at = source.text.indexOf(needle, from);
      if (at === -1) break;

      // 映射回原文：末字符的原文下标 +1 才是右开区间
      const start = source.map[at];
      const end = source.map[at + needle.length - 1] + 1;

      hits.push({
        ruleId: rule.id,
        word: rule.word,
        kind: rule.kind,
        replacement: rule.replacement,
        start,
        end,
        matched: text.slice(start, end),
      });

      from = at + needle.length;
    }
  }

  const blocked = hits.filter((h) => h.kind === "block");
  const review = hits.filter((h) => h.kind === "review");
  const verdict: WordVerdict = blocked.length > 0 ? "block" : review.length > 0 ? "review" : "pass";

  return {
    verdict,
    hits,
    replaced: verdict === "block" ? text : applyReplacements(text, hits),
    triggeredBy: blocked.length > 0 ? blocked : review,
  };
}

/**
 * 应用替换。
 *
 * **必须从后往前replace**：从前往后的话，第一次替换就会让
 * 后面所有命中的下标全部失效，替出来的位置全是错的。
 */
function applyReplacements(text: string, hits: readonly WordHit[]): string {
  const replacements = hits
    .filter((h) => h.kind === "replace" && h.replacement !== null)
    .sort((a, b) => b.start - a.start);

  let out = text;
  let lastStart = Number.POSITIVE_INFINITY;
  for (const hit of replacements) {
    // 重叠的命中只应用最靠后的那个，否则会替出乱码
    if (hit.end > lastStart) continue;
    out = out.slice(0, hit.start) + hit.replacement + out.slice(hit.end);
    lastStart = hit.start;
  }
  return out;
}

export interface RuleCheck {
  ok: boolean;
  error?: string;
}

/**
 * 词条本身的校验。
 *
 * 加词是**低门槛高破坏力**的操作：一个太短或太常见的词
 * 能在几分钟内把整个论坛变成不可用。
 */
export function checkWord(input: {
  word: string;
  kind: WordKind;
  replacement: string | null;
}): RuleCheck {
  const word = input.word.trim();
  if (!word) return { ok: false, error: "词条不能为空" };

  const normalized = normalize(word).text;
  if (normalized.length < MIN_WORD_LENGTH) {
    return {
      ok: false,
      error: `词条归一化后至少要 ${MIN_WORD_LENGTH} 个字符 —— 太短的词几乎匹配一切`,
    };
  }

  if (input.kind === "replace") {
    if (!input.replacement || !input.replacement.trim()) {
      return { ok: false, error: "替换档必须填替换文本" };
    }
    // 替换文本里含有词条本身会导致「替了等于没替」，还容易让人误以为规则没生效
    if (normalize(input.replacement).text.includes(normalized)) {
      return { ok: false, error: "替换文本里不能再包含这个词" };
    }
  }

  return { ok: true };
}

export const KIND_LABELS: Record<WordKind, string> = {
  block: "拦截",
  review: "送审",
  replace: "替换",
};

export const KIND_HINTS: Record<WordKind, string> = {
  block: "直接拒绝发布。代价是误伤时对方内容直接没了，慎用",
  review: "照常发布但进审核队列。默认用这一档",
  replace: "自动替换成指定文本后发布",
};

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind as WordKind] ?? kind;
}

/** 导出给测试与后台预览用 —— 归一化规则只有这一份 */
export function normalizeForMatch(input: string): string {
  return normalize(input).text;
}
