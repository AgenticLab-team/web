import "server-only";

import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";

import type { CurrentUser } from "@/lib/auth/session";
import { db, sqlite } from "@/lib/db";
import { messages, people } from "@/lib/db/schema";
import { assertGroupAccess } from "@/lib/queries/visibility";
import { endOfDayMs, startOfDayMs } from "@/lib/time";
import { resolveDisplayName } from "@/lib/users/display-name";
import { buildMatchExpression } from "@/lib/db/fts";

export interface PickableMessage {
  id: string;
  senderWxId: string;
  senderName: string;
  avatarUrl: string | null;
  content: string;
  type: string;
  ts: number;
  /** 被回复消息的 id。上游暂不透传引用关系，现阶段恒为 null（见 lib/messages/reply.ts） */
  replyToId: string | null;
}

export interface DayMessages {
  rows: PickableMessage[];
  /**
   * 这一天有多少条正文已经被存储裁剪丢掉了。
   *
   * 必须报出来：**裁剪过的一天和冷清的一天在结果里长得一模一样**，
   * 而在前者上做「群聊沉淀」会产出一篇残缺的记录，
   * 且没有任何迹象说明它是残缺的。
   */
  dropped: number;
}

/**
 * 取某天某群的消息，供转帖时挑选。
 *
 * 权限走统一收口：不在这个群就拿不到任何消息，
 * 而不是「拿到之后前端不显示」。
 */
export function messagesOfDay(
  user: CurrentUser | null,
  convId: string,
  date: string,
): DayMessages | null {
  if (!assertGroupAccess(user, convId)) return null;

  const rows = db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.convId, convId),
        eq(messages.isSend, false),
        gte(messages.ts, startOfDayMs(date)),
        lt(messages.ts, endOfDayMs(date)),
      ),
    )
    .orderBy(asc(messages.ts))
    .all();

  if (rows.length === 0) return { rows: [], dropped: 0 };

  const profiles = new Map(
    db
      .select({ wxId: people.wxId, name: people.displayName, avatar: people.avatarUrl })
      .from(people)
      .all()
      .map((p) => [p.wxId, p]),
  );

  // 正文被裁剪掉的不塞进列表 —— 空气泡比缺一条更让人困惑
  const usable = rows.filter((row) => row.content !== "");

  return {
    dropped: rows.length - usable.length,
    rows: usable.map((row) => ({
    id: row.id,
    senderWxId: row.senderWxId,
    senderName: resolveDisplayName([profiles.get(row.senderWxId)?.name, row.senderName], {
      wxId: row.senderWxId,
      fallback: "成员",
    }),
    avatarUrl: profiles.get(row.senderWxId)?.avatar ?? null,
    content: row.content,
    type: row.type,
    ts: row.ts,
    replyToId: row.replyToId,
  })),
  };
}

/**
 * 按关键词找消息，供转帖时挑选。
 *
 * ─────────────────────────────────────────
 * 「按天翻」这条路要求人先知道是哪天
 * ─────────────────────────────────────────
 *
 * 原来这一页只能选群 + 选日期。而人想整理的东西通常是
 * 「上个月有人讲过怎么做那个部署」—— 他记得内容，不记得日期。
 * 于是只能一天天翻，而群聊一天几百条，翻三天就放弃了。
 *
 * ─────────────────────────────────────────
 * 复用检索页那套，不另起一份
 * ─────────────────────────────────────────
 *
 * 分词、FTS 表达式、转义（`鉴权"OR"1` 这类输入）都在 `lib/db/fts.ts` 里
 * 处理过了。另写一份的话，那些坑要重新踩一遍 ——
 * 而 FTS5 的转义写错不会报错，只会**永远匹配不到任何东西**。
 *
 * 权限同样走 assertGroupAccess，和按天那条路一模一样。
 */
export function searchMessagesForConvert(
  user: CurrentUser | null,
  convId: string,
  query: string,
  limit = 120,
): DayMessages | null {
  if (!assertGroupAccess(user, convId)) return null;

  const match = buildMatchExpression(query);
  // 词被清成空 —— 返回空列表而不是全部消息。
  // 返回全部的话，一个只打了标点的搜索会显示成「这个群有 3 万条消息」
  if (!match) return { rows: [], dropped: 0 };

  /*
   * 用 `m.id = f.msg_id` 连表，**不是 rowid**。
   *
   * messages_fts 是独立的 fts5 虚表（不是 external content），
   * 它的 rowid 和 messages 的 rowid 没有任何关系 ——
   * 按 rowid 连出来的是**一批完全无关的消息**。
   *
   * 而这个错误极难从结果上看出来:命中数看着很正常（搜「台风」返回 22 条），
   * 只有真的去读那 22 条的内容才会发现里面一条台风都没有。
   * 上线之后对着生产数据抽查内容才抓到的。
   */
  const hits = sqlite
    .prepare(
      `SELECT m.id
         FROM messages_fts f
         JOIN messages m ON m.id = f.msg_id
        WHERE f.messages_fts MATCH ?
          AND m.conv_id = ?
          AND m.is_send = 0
          AND m.content != ''
        ORDER BY m.ts DESC
        LIMIT ?`,
    )
    .all(match, convId, limit) as { id: string }[];

  if (hits.length === 0) return { rows: [], dropped: 0 };

  const rows = db
    .select()
    .from(messages)
    .where(inArray(messages.id, hits.map((h) => h.id)))
    /*
     * 按时间**正序**返回。
     *
     * 检索是按相关度/倒序找出来的，但整理成帖子时要的是对话的顺序 ——
     * 一段倒过来的对话读起来是乱的，而人多半不会意识到是顺序问题，
     * 只会觉得「整理出来的东西看不懂」。
     */
    .orderBy(asc(messages.ts))
    .all();

  const profiles = new Map(
    db
      .select({ wxId: people.wxId, name: people.displayName, avatar: people.avatarUrl })
      .from(people)
      .all()
      .map((p) => [p.wxId, p]),
  );

  return {
    dropped: 0,
    rows: rows.map((row) => ({
      id: row.id,
      senderWxId: row.senderWxId,
      senderName: resolveDisplayName([profiles.get(row.senderWxId)?.name, row.senderName], {
        wxId: row.senderWxId,
        fallback: "成员",
      }),
      avatarUrl: profiles.get(row.senderWxId)?.avatar ?? null,
      content: row.content,
      type: row.type,
      ts: row.ts,
      replyToId: row.replyToId,
    })),
  };
}
