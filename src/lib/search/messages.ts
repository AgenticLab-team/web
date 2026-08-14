import "server-only";

import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";

import type { CurrentUser } from "@/lib/auth/session";
import { db, sqlite } from "@/lib/db";
import { buildMatchExpression, desegment } from "@/lib/db/fts";
import { groups, messages, people } from "@/lib/db/schema";
import { unsearchableWxIds } from "@/lib/privacy/queries";
import { visibleGroupIds } from "@/lib/queries/visibility";
import { endOfDayMs, startOfDayMs } from "@/lib/time";
import { resolveDisplayName } from "@/lib/users/display-name";

/**
 * 群消息检索。
 *
 * 微信自己的搜索烂到没法用，半年前的内容等于不存在 ——
 * 45,000 条消息里埋着这个社区全部的价值，现在没人能找到它们。
 * 这是整个站最有实际价值的功能之一。
 *
 * **权限收口是硬要求**：只能搜自己所在的群，且在 SQL 层就限制，
 * 不是查出来再过滤。搜索是最容易绕过权限的入口 ——
 * 只要能搜到只言片语，私密内容就已经泄露了。
 */

export interface MessageHit {
  id: string;
  convId: string;
  groupName: string;
  senderWxId: string;
  senderName: string;
  avatarUrl: string | null;
  content: string;
  type: string;
  ts: number;
  /** 命中的片段，关键词用 <mark> 包起来 */
  snippet: string;
}

export interface SearchOptions {
  query: string;
  /** 限定某个群，必须在可见范围内 */
  convId?: string;
  /** 限定发言人 */
  senderWxId?: string;
  /** 只搜自己说过的话 */
  onlyMine?: boolean;
  /** 起止日期 YYYY-MM-DD */
  from?: string;
  to?: string;
  msgType?: string;
  limit?: number;
  offset?: number;
  /**
   * 没给关键词时**列出最近的**，而不是返回空。
   *
   * ─────────────────────────────────────────
   * 为什么是显式开关，不是「空查询自动列出」
   * ─────────────────────────────────────────
   *
   * 开放 API 的 `GET /groups/<id>/messages` 要的是「读这个群的聊天记录」，
   * 关键词是可选的筛选条件 —— 不给就该给最近的那些。
   *
   * 而网页的 `/search` 是无条件调用这个函数的（还没输入时也调一次）。
   * 让空查询自动变成「列出全部」的话，那一页一打开就会显示
   * 「共 45000 条结果」并铺满整个群的聊天记录 —— 那不是搜索页该有的样子。
   *
   * 两个调用方要的东西相反，所以由调用方自己声明，不猜。
   */
  listWhenEmpty?: boolean;
}

export interface SearchResult {
  hits: MessageHit[];
  total: number;
  /** 可见范围为空时为 true，用于区分「没搜到」与「没权限」 */
  noAccess: boolean;
}

export function searchMessages(user: CurrentUser | null, options: SearchOptions): SearchResult {
  const allowed = visibleGroupIds(user);
  if (allowed.length === 0) return { hits: [], total: 0, noAccess: true };

  const expr = buildMatchExpression(options.query);
  if (!expr && !options.listWhenEmpty) return { hits: [], total: 0, noAccess: false };

  // 指定的群必须在可见范围内；越权指定等于没搜到，不报错也不泄露该群存在
  const scope = options.convId
    ? allowed.includes(options.convId)
      ? [options.convId]
      : []
    : allowed;
  if (scope.length === 0) return { hits: [], total: 0, noAccess: false };

  /*
   * ─────────────────────────────────────────
   * 上下界都要夹
   * ─────────────────────────────────────────
   *
   * 原来只夹了上界（`Math.min(limit, 100)`）。**SQLite 里负数 LIMIT 等于不限**，
   * 于是 `?limit=-1` 一路穿到 SQL，一次响应把整个群的消息全给出去 ——
   * 而开放 API 那条路上没有 offset 参数，那也是唯一能拿到最新一页以外内容的办法：
   * 它移掉的不是「一次返回多少」，是批量抽取的天花板。
   *
   * 夹在这里而不是只夹在路由上：这是所有调用方的最后一道关口。
   */
  const rawLimit = Number(options.limit);
  const limit = Math.min(Math.max(1, Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : 30), 100);
  const rawOffset = Number(options.offset);
  const offset = Math.max(0, Number.isFinite(rawOffset) ? Math.trunc(rawOffset) : 0);

  /*
   * 有关键词就走 FTS，没有就直接扫 messages。
   *
   * FTS5 **没有「匹配全部」的写法**，所以这不能靠让 buildMatchExpression
   * 返回一个万能表达式来解决，只能是两条不同的 FROM。
   * 其余部分（可见性、隐私开关、日期、类型筛选）两条路完全共用 ——
   * 它们全都写在 `m.` 上，一个字都不用改。
   */
  const keyworded = expr !== null;
  const source = keyworded ? "messages_fts f JOIN messages m ON m.id = f.msg_id" : "messages m";
  const match = keyworded ? "f.messages_fts MATCH ?" : "1 = 1";
  // 没有关键词就没有「命中的片段」—— 给空串，别拿正文冒充高亮
  const snippetCol = keyworded
    ? "snippet(messages_fts, 3, '<mark>', '</mark>', '…', 24) AS snip"
    : "'' AS snip";

  const filters: string[] = [];
  // 直接写 expr !== null 而不是复用上面的 keyworded —— 这里要靠它把类型收窄成 string
  const params: (string | number)[] = expr !== null ? [expr] : [];

  filters.push(`m.conv_id IN (${scope.map(() => "?").join(",")})`);
  params.push(...scope);

  const sender = options.onlyMine ? user?.wxId : options.senderWxId;
  if (sender) {
    filters.push("m.sender_wx_id = ?");
    params.push(sender);
  }

  /*
   * 关掉了「别人能搜到我的发言」的人，在别人的搜索里不出现。
   *
   * **排除自己**（`unsearchableWxIds` 的参数）：他关掉这个开关之后
   * 还得能搜自己说过的话 —— 那是他自己的东西，
   * 而「我上次在哪儿说过这事」正是搜索最常见的用法。
   *
   * 过滤和权限一样落在 SQL 里，不是查出来再过滤：`total` 是单独一条
   * count 查询，两边口径不一致的话会出现「共 30 条」但只列出 24 条，
   * 翻到第二页是空的。
   */
  const unsearchable = unsearchableWxIds(user);
  if (unsearchable.length > 0) {
    filters.push(`m.sender_wx_id NOT IN (${unsearchable.map(() => "?").join(",")})`);
    params.push(...unsearchable);
  }
  if (options.from) {
    filters.push("m.ts >= ?");
    params.push(startOfDayMs(options.from));
  }
  if (options.to) {
    filters.push("m.ts < ?");
    params.push(endOfDayMs(options.to));
  }
  if (options.msgType) {
    filters.push("m.type = ?");
    params.push(options.msgType);
  }

  const where = filters.length ? `AND ${filters.join(" AND ")}` : "";

  const total = (
    sqlite
      .prepare(
        `SELECT count(*) AS n
         FROM ${source}
         WHERE ${match} ${where}`,
      )
      .get(...params) as { n: number }
  ).n;

  /*
   * snippet() 由 FTS5 生成带高亮的片段。
   * 因为索引里的中文是逐字切开的，取出来要 desegment 还原，
   * 否则展示出来每个字之间都有空格。
   */
  const rows = sqlite
    .prepare(
      `SELECT m.id, m.conv_id, m.sender_wx_id, m.sender_name, m.content, m.type, m.ts,
              ${snippetCol}
       FROM ${source}
       WHERE ${match} ${where}
       ORDER BY m.ts DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as {
    id: string;
    conv_id: string;
    sender_wx_id: string;
    sender_name: string | null;
    content: string;
    type: string;
    ts: number;
    snip: string;
  }[];

  if (rows.length === 0) return { hits: [], total, noAccess: false };

  const groupNames = new Map(
    db
      .select({ convId: groups.convId, name: groups.name })
      .from(groups)
      .where(inArray(groups.convId, scope))
      .all()
      .map((g) => [g.convId, g.name]),
  );

  const profiles = new Map(
    db
      .select({ wxId: people.wxId, name: people.displayName, avatar: people.avatarUrl })
      .from(people)
      .where(inArray(people.wxId, [...new Set(rows.map((r) => r.sender_wx_id))]))
      .all()
      .map((p) => [p.wxId, p]),
  );

  return {
    hits: rows.map((row) => ({
      id: row.id,
      convId: row.conv_id,
      groupName: groupNames.get(row.conv_id) ?? "群聊",
      senderWxId: row.sender_wx_id,
      // people.displayName 和消息里的 sender_name 都可能是 wx_id 形态的脏值，统一过滤
      senderName: resolveDisplayName([profiles.get(row.sender_wx_id)?.name, row.sender_name], {
        wxId: row.sender_wx_id,
        fallback: "成员",
      }),
      avatarUrl: profiles.get(row.sender_wx_id)?.avatar ?? null,
      content: row.content,
      type: row.type,
      ts: row.ts,
      snippet: desegment(row.snip),
    })),
    total,
    noAccess: false,
  };
}

export interface ContextMessage {
  id: string;
  senderWxId: string;
  senderName: string;
  avatarUrl: string | null;
  content: string;
  type: string;
  ts: number;
  isTarget: boolean;
}

/**
 * 取某条消息的前后文。
 *
 * 搜索结果只有一句话往往看不懂 —— 群聊的意思大半在上下文里。
 * 点进去能看到前后各若干条，才算真的「找到了」。
 */
export function messageContext(
  user: CurrentUser | null,
  messageId: string,
  around = 8,
): { convId: string; groupName: string; messages: ContextMessage[] } | null {
  const allowed = visibleGroupIds(user);
  if (allowed.length === 0) return null;

  const target = db.select().from(messages).where(eq(messages.id, messageId)).get();
  if (!target || !allowed.includes(target.convId)) return null;

  const before = db
    .select()
    .from(messages)
    .where(and(eq(messages.convId, target.convId), lt(messages.ts, target.ts)))
    .orderBy(desc(messages.ts))
    .limit(around)
    .all()
    .reverse();

  const after = db
    .select()
    .from(messages)
    .where(and(eq(messages.convId, target.convId), gte(messages.ts, target.ts)))
    .orderBy(asc(messages.ts))
    .limit(around + 1)
    .all();

  const all = [...before, ...after];
  const profiles = new Map(
    db
      .select({ wxId: people.wxId, name: people.displayName, avatar: people.avatarUrl })
      .from(people)
      .where(inArray(people.wxId, [...new Set(all.map((m) => m.senderWxId))]))
      .all()
      .map((p) => [p.wxId, p]),
  );

  const group = db.select().from(groups).where(eq(groups.convId, target.convId)).get();

  return {
    convId: target.convId,
    groupName: group?.name ?? "群聊",
    messages: all.map((m) => ({
      id: m.id,
      senderWxId: m.senderWxId,
      senderName: resolveDisplayName([profiles.get(m.senderWxId)?.name, m.senderName], {
        wxId: m.senderWxId,
        fallback: "成员",
      }),
      avatarUrl: profiles.get(m.senderWxId)?.avatar ?? null,
      content: m.content,
      type: m.type,
      ts: m.ts,
      isTarget: m.id === messageId,
    })),
  };
}

/** 我在可见群里说过的话有多少条，用于「我的存档」入口 */
export function myMessageCount(user: CurrentUser | null): number {
  const allowed = visibleGroupIds(user);
  if (!user?.wxId || allowed.length === 0) return 0;
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(messages)
      .where(and(eq(messages.senderWxId, user.wxId), inArray(messages.convId, allowed)))
      .get()?.n ?? 0
  );
}
