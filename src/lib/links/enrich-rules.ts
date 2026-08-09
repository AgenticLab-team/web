/**
 * 用大模型给资源库的链接补标题和简介。纯函数：拼提示词、解析回复。
 *
 * ─────────────────────────────────────────
 * 现在的资源库是什么样
 * ─────────────────────────────────────────
 *
 * 生产上 200 条链接，其中 **58 条的标题就是域名本身**
 * （`box.muran.tech`、`typhoon.nmc.cn`），另一些是 URL 路径碎片
 * （`rsa`、`lopleec/imnotcnuser`）。而 `note` 存的是分享它的那条原话，
 * 经常和链接本身没关系 ——「非常抱歉由于服务器遭受持续攻击」
 * 是一条故障通知，不是对链接的说明。
 *
 * 所以要把链接连同**它出现时的上下文**交给模型，让它说清楚这是什么。
 *
 * ─────────────────────────────────────────
 * 但是不许编
 * ─────────────────────────────────────────
 *
 * links.ts 里那句注释写着「抓不到就留空，**不编**」。
 * 接上大模型之后这条更要紧，因为模型编出来的东西**读起来是通顺的**：
 * 一个语气笃定、格式工整、内容却是猜的简介，比一行域名危险得多 ——
 * 域名至少诚实地说明「我们不知道这是什么」。
 *
 * 这里用三道拦：
 *
 *   1. 提示词里要求「看不出来就回 unknown」，并且给了明确的例子
 *   2. 解析时把 unknown 当成**正常结果**，不是失败 —— 于是不写库
 *   3. 模型自称有把握、但简介里出现了上下文中根本没有的具体承诺
 *      （价格、时间、数量）时降级为 unknown
 *
 * 第三条是因为模型最爱在这几处补细节，而这几处恰恰最容易被人当真。
 */

export interface EnrichInput {
  url: string;
  domain: string;
  /** 现在的标题，多半是域名或路径碎片 */
  currentTitle: string;
  /** 分享它的那条消息原文 */
  sharedIn: string | null;
  /** 同一个群里前后几条，给模型一点语境 */
  context: string[];
}

export const SYSTEM_PROMPT = `你在给一个技术社区的「资源库」整理链接条目。

社区成员在微信群里随手分享链接，系统把链接抓了下来，但标题往往只是域名，
说明是分享时那条消息的原文 —— 而那条消息经常在讲别的事。

你的任务：根据链接本身和它出现时的上下文，给出一个清楚的标题和一句简介。

**最重要的一条规则：看不出来就说看不出来。**

上下文里没有说明这个链接是什么的时候，回 {"known": false}。
不要根据域名猜、不要根据 URL 路径编、不要写「这可能是一个……」。
一个编出来的简介读起来是通顺的，因此比「不知道」危险得多。

具体地：
- 上下文只说了「大家可以去抢 handle 了」→ 你知道这是个抢注入口，可以写
- 上下文是「服务器被攻击了，抱歉」→ 那在讲故障，没说链接是什么，回 known: false
- 上下文为空、只有一个域名 → 回 known: false

不要编造上下文里没有的价格、时间、数量、功能列表。

只输出 JSON，不要解释，不要代码块围栏：
{"known": true, "title": "不超过 24 字", "summary": "一到两句，不超过 60 字"}
或
{"known": false}`;

export function buildEnrichPrompt(input: EnrichInput): {
  role: "system" | "user";
  content: string;
}[] {
  const parts = [`链接：${input.url}`, `域名：${input.domain}`];
  if (input.currentTitle && input.currentTitle !== input.domain) {
    parts.push(`URL 里带的文字：${input.currentTitle}`);
  }
  if (input.sharedIn) parts.push(`分享它的那条消息：${input.sharedIn}`);
  if (input.context.length > 0) {
    parts.push(`群里前后的对话：\n${input.context.join("\n")}`);
  } else {
    parts.push("（没有任何上下文）");
  }

  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: parts.join("\n") },
  ];
}

export type EnrichOutcome =
  | { kind: "known"; title: string; summary: string }
  /** 模型说不出来 —— 这是正常结果，不写库，也不要反复重试 */
  | { kind: "unknown"; reason: string }
  /** 回复没法解析 —— 这是故障，要报出来 */
  | { kind: "unparsable"; raw: string };

export const MAX_TITLE_CHARS = 24;
export const MAX_SUMMARY_CHARS = 80;

/**
 * 模型最爱在这几处补细节，而这几处恰恰最容易被人当真。
 *
 * 简介里出现了具体的数字承诺、而上下文里根本没提过的，一律降级为
 * unknown —— 宁可少一条简介，不要多一条看起来权威的假话。
 */
const FABRICATION_MARKERS = [
  /\d+\s*(元|块|美元|刀|\$|USD|RMB)/,
  /(免费|优惠)\s*\d+/,
  /\d+\s*(个月|年|天|小时)(免费|有效|试用)/,
  /支持\s*\d+\s*(种|个|项)/,
];

function stripFences(text: string): string {
  return text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}

/**
 * 从回复里取出 JSON。
 *
 * 推理模型经常在 JSON 前后带一句话，或者裹上代码块围栏。
 * 直接 JSON.parse 会全军覆没，而**全军覆没会被误读成「模型不可用」**——
 * 实际上只是外面多了两个反引号。
 */
export function parseEnrichResponse(raw: string, context: string): EnrichOutcome {
  const text = stripFences(raw);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return { kind: "unparsable", raw: raw.slice(0, 200) };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { kind: "unparsable", raw: raw.slice(0, 200) };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "unparsable", raw: raw.slice(0, 200) };
  }

  const obj = parsed as Record<string, unknown>;
  if (obj.known === false) return { kind: "unknown", reason: "模型说上下文里看不出这是什么" };

  const title = typeof obj.title === "string" ? obj.title.trim() : "";
  const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";

  if (!title || !summary) {
    return { kind: "unknown", reason: "模型说知道，但没给出标题或简介" };
  }

  /*
   * 编造检查。
   *
   * 只在**上下文里也没有**这个数字时才算编 ——
   * 上下文真的说了「9.9 元」的话，简介里出现它是对的。
   */
  for (const marker of FABRICATION_MARKERS) {
    const hit = summary.match(marker);
    if (hit && !context.includes(hit[0].replace(/\s/g, ""))) {
      return {
        kind: "unknown",
        reason: `简介里出现了上下文里没有的具体承诺「${hit[0]}」—— 宁可不写`,
      };
    }
  }

  return {
    kind: "known",
    title: title.slice(0, MAX_TITLE_CHARS),
    summary: summary.slice(0, MAX_SUMMARY_CHARS),
  };
}

/**
 * 值不值得送去问模型。
 *
 * 已经有像样标题和说明的不用花这个钱 ——
 * 而且**重跑整个资源库应该是幂等的**，否则每次跑都在把
 * 已经好了的条目换成另一个说法，谁也说不清哪次是对的。
 */
export function needsEnrichment(link: {
  title: string;
  domain: string;
  note: string | null;
  aiTitle: string | null;
  aiSummary: string | null;
  aiCheckedAt: number | null;
}): boolean {
  if (link.aiTitle && link.aiSummary) return false;
  // 问过一次说不知道的，不要每次同步都再问一遍
  if (link.aiCheckedAt) return false;
  return true;
}
