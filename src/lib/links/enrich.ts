import "server-only";

import { and, asc, desc, eq, gt, isNull, lt, or } from "drizzle-orm";

import { db } from "@/lib/db";
import { linkMentions, links, messages, people } from "@/lib/db/schema";
import { hasAuthoritativeFacts } from "@/lib/github/link-lookup";
import { LlmError, LlmNotConfigured, chat } from "@/lib/llm/client";
import { resolveDisplayName } from "@/lib/users/display-name";

import {
  buildEnrichPrompt,
  hasEnoughContext,
  needsEnrichment,
  parseEnrichResponse,
} from "./enrich-rules";

/**
 * 给资源库的链接补标题和简介。
 *
 * 规则（提示词怎么写、回复怎么解析、什么情况算编造）在 enrich-rules.ts，
 * 那边是纯函数、离线测得很密。这里只负责取上下文、调模型、落库。
 */

/** 取分享消息前后各几条当语境 */
const CONTEXT_BEFORE = 3;
const CONTEXT_AFTER = 2;

/**
 * 一条链接出现时，群里在聊什么。
 *
 * 只取**同一个群**里紧挨着的那几条 —— 跨群拼上下文会把
 * 完全无关的对话喂给模型，而模型会努力把它们联系起来，
 * 那正是编造的开始。
 */
function contextFor(linkId: string): { sharedIn: string | null; context: string[] } {
  /*
   * 取**第一次**被分享时的语境。
   *
   * 一条链接可能被分享过很多次，而第一次那段对话通常是在介绍它是什么；
   * 后来的转发多半只有一句「+1」「收藏了」——
   * 拿那种语境去问模型，它会努力从「收藏了」里推断这是什么。
   */
  const mention = db
    .select()
    .from(linkMentions)
    .where(eq(linkMentions.linkId, linkId))
    .orderBy(asc(linkMentions.sharedAt))
    .limit(1)
    .get();

  // 手动提交的链接没有来源消息 —— 那就没有语境，如实返回空
  if (!mention?.messageId) return { sharedIn: null, context: [] };

  const anchor = db.select().from(messages).where(eq(messages.id, mention.messageId)).get();
  if (!anchor) return { sharedIn: null, context: [] };

  const before = db
    .select()
    .from(messages)
    .where(and(eq(messages.convId, anchor.convId), lt(messages.ts, anchor.ts)))
    .orderBy(desc(messages.ts))
    .limit(CONTEXT_BEFORE)
    .all()
    .reverse();

  const after = db
    .select()
    .from(messages)
    .where(and(eq(messages.convId, anchor.convId), gt(messages.ts, anchor.ts)))
    .orderBy(asc(messages.ts))
    .limit(CONTEXT_AFTER)
    .all();

  const nameOf = (wxId: string | null) => {
    if (!wxId) return "某人";
    const p = db.select().from(people).where(eq(people.wxId, wxId)).get();
    return p ? resolveDisplayName([p.displayName], { wxId, fallback: "某人" }) : "某人";
  };

  return {
    sharedIn: anchor.content,
    context: [...before, ...after].map((m) => `${nameOf(m.senderWxId)}：${m.content}`),
  };
}

export interface EnrichReport {
  scanned: number;
  written: number;
  unknown: number;
  failed: number;
  notes: string[];
}

/**
 * 跑一批。
 *
 * ─────────────────────────────────────────
 * 「不知道」要记下来，「失败」不要
 * ─────────────────────────────────────────
 *
 * 模型说不出这是什么 —— 那是个结论，记下 aiCheckedAt，下次不再问。
 * 调用出错（超时、额度、网络）—— 那是故障，**不能**记 aiCheckedAt，
 * 否则一次网络抖动会让这几十条链接**永远**不再被整理，
 * 而且没有任何地方看得出来。
 */
export async function enrichLinks(options: { limit?: number; force?: boolean } = {}): Promise<EnrichReport> {
  const report: EnrichReport = { scanned: 0, written: 0, unknown: 0, failed: 0, notes: [] };

  const candidates = db
    .select()
    .from(links)
    .where(
      options.force
        ? undefined
        : and(eq(links.hidden, false), or(isNull(links.aiCheckedAt), isNull(links.aiTitle))),
    )
    .orderBy(desc(links.shareCount))
    .limit(options.limit ?? 50)
    .all()
    .filter((l) => options.force || needsEnrichment(l))
    /*
     * 已经从来源本身问到答案的（现在只有 GitHub），**一律不问模型**。
     *
     * 不是省钱那么简单：模型在这里只能猜，而 GitHub 直接告诉了我们
     * 这个仓库叫什么、是干什么的。两份并存的话，界面上必然要挑一份显示 ——
     * 挑猜的那份是错的，挑准的那份则意味着刚才那次调用白花了。
     *
     * `force` 也不例外。重跑整理是为了换模型重来一遍，
     * 而这些条目的答案根本不来自模型。
     */
    .filter((l) => !hasAuthoritativeFacts(l));

  for (const link of candidates) {
    report.scanned++;
    const { sharedIn, context } = contextFor(link.id);

    /*
     * 没有语境就别问了。
     *
     * 答案必然是「不知道」，问一次只会白花一次调用 ——
     * 而且模型在这种情况下容易返回空内容，
     * 那会被记成故障，和「模型没配好」混进同一个计数里。
     */
    if (!hasEnoughContext({ sharedIn, context, currentTitle: link.title, domain: link.domain })) {
      db.update(links)
        .set({ aiCheckedAt: Date.now(), aiModel: process.env.LLM_MODEL ?? null })
        .where(eq(links.id, link.id))
        .run();
      report.unknown++;
      continue;
    }

    let raw: string;
    try {
      const result = await chat(
        buildEnrichPrompt({
          url: link.url,
          domain: link.domain,
          currentTitle: link.title,
          sharedIn,
          context,
        }),
        { maxTokens: 500 },
      );
      raw = result.text;
    } catch (error) {
      report.failed++;
      if (error instanceof LlmNotConfigured) {
        report.notes.push(error.message);
        // 没配模型就没必要继续试剩下的
        break;
      }
      report.notes.push(
        `${link.domain}：${error instanceof LlmError ? error.message : String(error)}`,
      );
      continue;
    }

    const outcome = parseEnrichResponse(raw, [sharedIn ?? "", ...context].join("\n"));
    const now = Date.now();

    if (outcome.kind === "known") {
      db.update(links)
        .set({
          aiTitle: outcome.title,
          aiSummary: outcome.summary,
          aiCheckedAt: now,
          aiModel: process.env.LLM_MODEL ?? null,
        })
        .where(eq(links.id, link.id))
        .run();
      report.written++;
    } else if (outcome.kind === "unknown") {
      db.update(links)
        .set({ aiCheckedAt: now, aiModel: process.env.LLM_MODEL ?? null })
        .where(eq(links.id, link.id))
        .run();
      report.unknown++;
    } else {
      /*
       * 解析不出来 —— 不写 aiCheckedAt。
       *
       * 这多半是模型今天状态不好或者换了模型,下次还该再试。
       * 记下来就等于永久放弃这一条。
       */
      report.failed++;
      report.notes.push(`${link.domain}：回复读不出来「${outcome.raw.slice(0, 60)}」`);
    }
  }

  return report;
}

/** 资源库现在被整理到什么程度 —— 后台要显示 */
export function enrichProgress(): {
  total: number;
  enriched: number;
  checkedButUnknown: number;
  untouched: number;
} {
  const all = db.select().from(links).where(eq(links.hidden, false)).all();
  /*
   * 「已整理」要把**来源给的那一份**也算上。
   *
   * 只数 ai_* 的话，GitHub 那些条目会永远待在「还没整理」里 ——
   * 而它们的简介比模型写的还准。后台那个数字会变成一个
   * 无论跑多少轮都补不完的缺口，然后有人会一直去点「再跑一批」，
   * 每一次都在为一批不需要模型的链接付钱。
   */
  const enriched = all.filter((l) => (l.aiTitle && l.aiSummary) || hasAuthoritativeFacts(l)).length;
  const checked = all.filter((l) => l.aiCheckedAt && !l.aiTitle && !hasAuthoritativeFacts(l)).length;
  return {
    total: all.length,
    enriched,
    checkedButUnknown: checked,
    untouched: all.length - enriched - checked,
  };
}
