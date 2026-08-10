/**
 * 群聊问答的提示词与解析。纯函数，不碰数据库、不打网络。
 *
 * ─────────────────────────────────────────
 * 这个功能最坏的形态是「答得很好，但那件事群里没发生过」
 * ─────────────────────────────────────────
 *
 * 模型自己就知道 MCP 鉴权怎么做。问它「群里讨论过 MCP 鉴权吗」，
 * 它会顺手把自己知道的答出来，再挑几条沾边的消息当引用 ——
 * 看起来完美，而**那场讨论根本没发生过**。
 *
 * 那比答不出来糟得多：答不出来的时候人会自己去搜；
 * 答错了的时候人会拿着一个不存在的结论去跟群里的人对话。
 *
 * 所以这个文件里几乎每一条规则都在做同一件事：
 * **把模型摁回到给它的那几段材料里**。
 *
 * ─────────────────────────────────────────
 * 引用是这个功能的全部价值
 * ─────────────────────────────────────────
 *
 * 「群里讨论过，你自己去看」比一段总结有用得多 ——
 * 总结会丢掉语气、条件和反对意见，而原话不会。
 *
 * 所以引用不是装饰：编号必须能对回真实的那一段，
 * 对不回去的一律丢掉（`validCitations`）。一个指向虚空的引用
 * 会让人以为自己没找到，而不是它根本不存在。
 */

export interface RagSource {
  /** 给模型看的编号，从 1 开始 */
  index: number;
  /** 这一段第一条消息的 id —— 引用要靠它落回原文 */
  messageId: string;
  convId: string;
  /** 段落所属的日期（东八区），给模型判断时间用 */
  date: string;
  text: string;
}

const SYSTEM_PROMPT = `你在帮人回忆一个微信群里聊过什么。

材料是从这个群的历史消息里检索出来的若干段对话，每段前面有编号。

铁律：
1. **只依据材料回答**。你自己知道的东西一个字都不要写进来 ——
   哪怕材料里的说法是错的、过时的，你要报告的也是「群里当时是这么说的」。
2. 材料里没有的，就说没有。不要用「可能」「一般来说」把话圆过去。
3. 每一句结论后面标出处，格式是 [1]、[2]，可以标多个 [1][3]。
   标不出编号的句子，说明它不是从材料里来的 —— 那句话就不该写。
4. 群里的说法有分歧时**把分歧写出来**，不要挑一个当结论。
   「A 说用 X，B 说 X 在这个场景不行」比一个干净的答案有用得多。
5. 不要复述整段材料，也不要逐条罗列。像跟人说话那样，
   两三句话讲清楚群里的结论是什么、谁提出的、有什么前提。

材料完全答不上这个问题时，回：
{"found": false, "reason": "一句话说明检索到的内容都在讲什么，让人知道不是没搜到而是没聊过"}

答得上时回：
{"found": true, "answer": "带 [n] 出处标记的回答，不超过 300 字", "cites": [1, 3]}

只输出 JSON，不要解释，不要代码块围栏。`;

export function buildRagPrompt(
  question: string,
  sources: readonly RagSource[],
): { role: "system" | "user"; content: string }[] {
  const material = sources
    .map((s) => `[${s.index}]（${s.date}）\n${s.text}`)
    .join("\n\n");

  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `问题：${question}\n\n材料：\n\n${material}`,
    },
  ];
}

export type RagOutcome =
  | { kind: "answer"; answer: string; cites: number[] }
  /** 材料里没有 —— 这是**正常结果**，不是故障 */
  | { kind: "not-found"; reason: string }
  /** 回复没法解析 —— 这是故障，要报出来 */
  | { kind: "unparsable"; raw: string };

export const MAX_ANSWER_CHARS = 600;

function stripFences(text: string): string {
  return text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}

/**
 * 从回复里取出 JSON。
 *
 * 推理模型经常在 JSON 前后带一句话，或者裹上代码块围栏 ——
 * 直接 JSON.parse 会全军覆没，而全军覆没会被误读成「模型不可用」。
 * 这一段和链接补全那边是同一个坑，处理方式保持一致。
 */
export function parseRagResponse(raw: string): RagOutcome {
  const text = stripFences(raw);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return { kind: "unparsable", raw };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { kind: "unparsable", raw };
  }

  if (typeof parsed !== "object" || parsed === null) return { kind: "unparsable", raw };
  const obj = parsed as Record<string, unknown>;

  if (obj.found === false) {
    const reason = typeof obj.reason === "string" ? obj.reason.trim() : "";
    return { kind: "not-found", reason: reason || "检索到的内容里没有提到这件事" };
  }

  if (obj.found !== true) return { kind: "unparsable", raw };

  const answer = typeof obj.answer === "string" ? obj.answer.trim() : "";
  if (!answer) return { kind: "unparsable", raw };

  /*
   * **一条出处都没标的回答，当成没答上**。
   *
   * 那正是模型在拿自己知道的东西作答的样子 —— 它答得很流畅，
   * 却标不出是从哪一段来的，因为确实不是从材料里来的。
   *
   * 这一条比任何提示词都管用：提示词是请求，这里是拒收。
   */
  const cites = Array.isArray(obj.cites)
    ? obj.cites.filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n > 0)
    : [];
  if (cites.length === 0) {
    return { kind: "not-found", reason: "模型给不出出处，这一条不作数" };
  }

  return {
    kind: "answer",
    answer: answer.slice(0, MAX_ANSWER_CHARS),
    cites: [...new Set(cites)],
  };
}

/**
 * 只留下**真实存在**的引用。
 *
 * 模型会编编号 —— 给了 8 段材料，它标个 [11] 出来。
 * 不校验的话，界面上会出现一个点不开的引用，
 * 而人会以为是自己没找到，不会想到它根本不存在。
 *
 * 同时把正文里出现、而 cites 数组漏掉的编号也补进来：
 * 两处不一致时以**正文标了的**为准 —— 人读的是正文。
 */
export function validCitations(
  outcome: Extract<RagOutcome, { kind: "answer" }>,
  sources: readonly RagSource[],
): number[] {
  const known = new Set(sources.map((s) => s.index));

  const inText = new Set<number>();
  for (const m of outcome.answer.matchAll(/\[(\d+)\]/g)) {
    inText.add(Number(m[1]));
  }

  const all = new Set([...outcome.cites, ...inText]);
  return [...all].filter((n) => known.has(n)).sort((a, b) => a - b);
}

/**
 * 把正文里指向不存在的编号的标记去掉。
 *
 * 留着的话，读的人会去找 [11]，找不到，然后不再相信别的引用 ——
 * **一个坏引用会连累所有好引用**。
 */
export function stripUnknownMarkers(answer: string, sources: readonly RagSource[]): string {
  const known = new Set(sources.map((s) => s.index));
  return answer.replace(/\[(\d+)\]/g, (whole, n) => (known.has(Number(n)) ? whole : ""));
}
