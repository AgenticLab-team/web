import "server-only";

import type { CurrentUser } from "@/lib/auth/session";
import { LlmNotConfigured } from "@/lib/llm/client";
import { chat } from "@/lib/llm/client";
import { dateKey } from "@/lib/time";
import {
  buildRagPrompt,
  parseRagResponse,
  stripUnknownMarkers,
  validCitations,
  type RagSource,
} from "@/lib/search/rag-rules";
import { semanticSearch, type SemanticHit } from "@/lib/search/semantic";

/**
 * 群聊问答。
 *
 * ─────────────────────────────────────────
 * 检索这一层**一行都不重写**
 * ─────────────────────────────────────────
 *
 * `semanticSearch` 已经守着两条这个功能最不能破的规矩：
 *
 *   · **只搜这个人在的群**（visibleGroupIds）
 *   · **关掉「别人能搜到我」的人，整段丢掉**，不是只抹掉他那几行 ——
 *     因为那一段的向量是连他说的话一起嵌进去的，只抹字面的话，
 *     搜的人能从「这段怎么会匹配上」反推出他说过什么
 *
 * 自己再写一遍检索的话，这两条迟早分叉，而分叉的方向一定是更松的
 * 那一边泄露。所以这里只做一件事：**把它的结果喂给模型**。
 *
 * ─────────────────────────────────────────
 * 答不上来是正常结果，编出来才是故障
 * ─────────────────────────────────────────
 *
 * 模型自己就知道大多数技术问题。问它「群里讨论过 X 吗」，
 * 它会顺手把自己知道的答出来再挑几条沾边的当引用 ——
 * 看起来完美，而那场讨论根本没发生过。
 *
 * 防线有三道，缺一不可：
 *   ① 提示词要求每句话标出处（规则层）
 *   ② **一条出处都没标的回答直接当成没答上**（规则层，比提示词硬）
 *   ③ 编号对不回真实段落的引用一律丢掉（规则层）
 * 这里负责第四道：**材料为空时根本不问模型**。
 */

/** 喂给模型几段。太多会稀释注意力，也把提示词撑爆 */
const MAX_SOURCES = 8;

export type AskResult =
  | { kind: "answer"; answer: string; sources: AnsweredSource[]; pending: number }
  | { kind: "not-found"; reason: string; searched: number; pending: number }
  | { kind: "no-access" }
  | { kind: "unavailable"; reason: string };

export interface AnsweredSource {
  index: number;
  groupName: string;
  date: string;
  /** 落回原文用：/archive?group=…&m=<id> */
  convId: string;
  messageId: string;
  /** 这一段的原话，展开给人看 —— 引用的价值就在这里 */
  messages: { senderName: string; content: string }[];
}

/**
 * 把一段检索结果变成给模型看的材料。
 *
 * 只取每段的**前几条**：一段可能有二十条，全喂进去的话八段就把
 * 提示词撑爆，而模型真正需要的是这段在讲什么，不是逐字全文。
 */
function toSource(hit: SemanticHit, index: number): RagSource | null {
  const first = hit.messages[0];
  if (!first) return null;

  const text = hit.messages
    .slice(0, 12)
    .map((m) => `${m.senderName}：${m.content}`)
    .join("\n");

  return {
    index,
    messageId: first.id,
    convId: hit.convId,
    date: dateKey(hit.startTs),
    text,
  };
}

export async function askGroups(
  user: CurrentUser | null,
  question: string,
): Promise<AskResult> {
  const trimmed = question.trim();
  if (!trimmed) return { kind: "not-found", reason: "先问点什么", searched: 0, pending: 0 };

  const found = await semanticSearch(user, trimmed, MAX_SOURCES);

  if (found.noAccess) return { kind: "no-access" };
  if (found.error) return { kind: "unavailable", reason: found.error };

  const sources = found.hits
    .map((hit, i) => ({ hit, source: toSource(hit, i + 1) }))
    .filter((x): x is { hit: SemanticHit; source: RagSource } => x.source !== null);

  /*
   * **材料为空就不问模型**。
   *
   * 问了的话，它会拿自己知道的东西答一段，而那一段读起来
   * 和真的从群里检索出来的一模一样 —— 这是这个功能最坏的失败形态。
   * 顺带也省掉一次没有意义的调用。
   */
  if (sources.length === 0) {
    return {
      kind: "not-found",
      reason: "在你能看到的群里没有检索到相关的对话",
      searched: 0,
      pending: found.pending,
    };
  }

  let raw: string;
  try {
    const result = await chat(
      buildRagPrompt(
        trimmed,
        sources.map((s) => s.source),
      ),
      // 温度压到底：这不是创作，是复述群里说过的话
      { temperature: 0, maxTokens: 900, timeoutMs: 45_000 },
    );
    raw = result.text;
  } catch (error) {
    /*
     * 模型调不通时**如实说**，不要退回成「没找到」——
     * 那会让人以为群里没聊过，而实际上是这一侧坏了。
     * 两者的下一步完全不同：一个是去别处找，一个是修。
     */
    return {
      kind: "unavailable",
      reason:
        error instanceof LlmNotConfigured
          ? "群聊问答还没配好对话模型"
          : `模型现在调不通：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const outcome = parseRagResponse(raw);

  if (outcome.kind === "unparsable") {
    return { kind: "unavailable", reason: "模型返回的内容解析不了" };
  }

  if (outcome.kind === "not-found") {
    return {
      kind: "not-found",
      reason: outcome.reason,
      searched: sources.length,
      pending: found.pending,
    };
  }

  const cited = validCitations(outcome, sources.map((s) => s.source));

  /*
   * 校验之后一条引用都不剩 = 模型标的编号全是编的。
   * 这种回答不能给出去 —— 它读起来最像真的。
   */
  if (cited.length === 0) {
    return {
      kind: "not-found",
      reason: "模型给出的出处对不上检索到的内容，这一条不作数",
      searched: sources.length,
      pending: found.pending,
    };
  }

  const citedSet = new Set(cited);

  return {
    kind: "answer",
    answer: stripUnknownMarkers(outcome.answer, sources.map((s) => s.source)),
    // **只回被引用到的那几段**：没被引用的段落摆出来只会让人不知道该看哪一条
    sources: sources
      .filter((s) => citedSet.has(s.source.index))
      .map(({ hit, source }) => ({
        index: source.index,
        groupName: hit.groupName,
        date: source.date,
        convId: source.convId,
        messageId: source.messageId,
        messages: hit.messages.slice(0, 12).map((m) => ({
          senderName: m.senderName,
          content: m.content,
        })),
      })),
    pending: found.pending,
  };
}
