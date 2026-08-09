import "server-only";

import { and, asc, desc, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";

import type { CurrentUser } from "@/lib/auth/session";
import { db, sqlite } from "@/lib/db";
import { messages, people } from "@/lib/db/schema";
import { ARCHIVE_PAGE_SIZE, type MessageOrder } from "@/lib/messages/archive-rules";
import { paginate, type PageSlice } from "@/lib/pagination";
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
  /** 这一天**能显示出来**的总条数（不受分页影响）—— 分页控件和标题都要它 */
  total: number;
  /** 夹好边界的分页切片。页码来自 URL，是敌对输入 —— 见 lib/pagination.ts */
  slice: PageSlice;
}

/**
 * 「这一天能显示出来的消息」的过滤条件。
 *
 * 单独抽出来是因为它有两个使用者：切某一页的查询，和
 * 「某条消息在这一天里排第几」的计数查询（lib/messages/locate.ts）。
 * 两边条件差一条，算出来的页码就会差一位 ——
 * 表现是点开通知落到了那一页，而那条消息在隔壁页。
 *
 * `content != ''` 这一条尤其容易漏：正文被存储裁剪掉的消息
 * 不进列表（空气泡比缺一条更让人困惑），所以也不能占下标。
 */
export function dayScope(convId: string, date: string) {
  return and(
    eq(messages.convId, convId),
    eq(messages.isSend, false),
    gte(messages.ts, startOfDayMs(date)),
    lt(messages.ts, endOfDayMs(date)),
    ne(messages.content, ""),
  );
}

/**
 * 取某天某群的消息，供回看与转帖时挑选。
 *
 * 权限走统一收口：不在这个群就拿不到任何消息，
 * 而不是「拿到之后前端不显示」。
 *
 * **必须分页**：真实数据里一天最多 4553 条。原来这里是一次
 * 把一整天全查出来全渲染出去 —— 那既是一个几兆的 HTML，
 * 也是「跳到那一天等于没跳」的根源。
 */
export function messagesOfDay(
  user: CurrentUser | null,
  convId: string,
  date: string,
  options: {
    order?: MessageOrder;
    /** URL 上的原始页码，或定位算出来的页码。夹边界在这里做，调用方不用管 */
    page?: unknown;
    perPage?: number;
  } = {},
): DayMessages | null {
  if (!assertGroupAccess(user, convId)) return null;

  const order = options.order ?? "asc";
  const perPage = Math.max(1, options.perPage ?? ARCHIVE_PAGE_SIZE);

  const scope = dayScope(convId, date);

  /*
   * 一次查询同时数出「能显示的」和「被裁剪掉的」。
   * 分成两条 SQL 的话，两次之间同步进程刚好写进新消息，
   * 两个数就对不上了 —— 概率低，但对不上时没人查得出来。
   */
  const counts = db
    .select({
      total: sql<number>`sum(case when ${messages.content} != '' then 1 else 0 end)`,
      dropped: sql<number>`sum(case when ${messages.content} = '' then 1 else 0 end)`,
    })
    .from(messages)
    .where(
      and(
        eq(messages.convId, convId),
        eq(messages.isSend, false),
        gte(messages.ts, startOfDayMs(date)),
        lt(messages.ts, endOfDayMs(date)),
      ),
    )
    .get();

  const dropped = counts?.dropped ?? 0;
  const total = counts?.total ?? 0;
  const slice = paginate(options.page, total, perPage);
  if (total === 0) return { rows: [], dropped, total: 0, slice };

  /*
   * 排序带上 id 做次级键。
   *
   * 同一秒里好几条消息是群聊的常态，而只按 ts 排的话
   * SQLite 不保证同值行的相对顺序 —— 翻页时**同一条消息
   * 可能在第 1 页和第 2 页各出现一次，另一条一次都不出现**。
   * 这种漏更没人会察觉：列表看起来一切正常。
   */
  const rows = db
    .select()
    .from(messages)
    .where(scope)
    .orderBy(
      ...(order === "desc"
        ? [desc(messages.ts), desc(messages.id)]
        : [asc(messages.ts), asc(messages.id)]),
    )
    .limit(slice.perPage)
    .offset(slice.offset)
    .all();

  // 只查这一页出现过的人。原来是把整张 people 表拉进内存 —— 每次渲染一遍
  const senderIds = [...new Set(rows.map((r) => r.senderWxId))];
  const profiles = new Map(
    (senderIds.length === 0
      ? []
      : db
          .select({ wxId: people.wxId, name: people.displayName, avatar: people.avatarUrl })
          .from(people)
          .where(inArray(people.wxId, senderIds))
          .all()
    ).map((p) => [p.wxId, p]),
  );

  return {
    dropped,
    total,
    slice,
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
  if (!match) return { rows: [], dropped: 0, total: 0, slice: paginate(1, 0, limit) };

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

  if (hits.length === 0) return { rows: [], dropped: 0, total: 0, slice: paginate(1, 0, limit) };

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
    // 搜索结果本身就是一次性截断的一批（见 limit），不再二次分页 —— 永远只有一页
    total: rows.length,
    slice: paginate(1, rows.length, Math.max(1, rows.length)),
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
