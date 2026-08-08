import "server-only";

import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";

import type { CurrentUser } from "@/lib/auth/session";
import { db, sqlite } from "@/lib/db";
import { buildMatchExpression, desegment } from "@/lib/db/fts";
import { groups, messages, people } from "@/lib/db/schema";
import { visibleGroupIds } from "@/lib/queries/visibility";
import { endOfDayMs, startOfDayMs } from "@/lib/time";

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
  if (!expr) return { hits: [], total: 0, noAccess: false };

  // 指定的群必须在可见范围内；越权指定等于没搜到，不报错也不泄露该群存在
  const scope = options.convId
    ? allowed.includes(options.convId)
      ? [options.convId]
      : []
    : allowed;
  if (scope.length === 0) return { hits: [], total: 0, noAccess: false };

  const limit = Math.min(options.limit ?? 30, 100);
  const offset = options.offset ?? 0;

  const filters: string[] = [];
  const params: (string | number)[] = [expr];

  filters.push(`m.conv_id IN (${scope.map(() => "?").join(",")})`);
  params.push(...scope);

  const sender = options.onlyMine ? user?.wxId : options.senderWxId;
  if (sender) {
    filters.push("m.sender_wx_id = ?");
    params.push(sender);
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
         FROM messages_fts f
         JOIN messages m ON m.id = f.msg_id
         WHERE f.messages_fts MATCH ? ${where}`,
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
              snippet(messages_fts, 3, '<mark>', '</mark>', '…', 24) AS snip
       FROM messages_fts f
       JOIN messages m ON m.id = f.msg_id
       WHERE f.messages_fts MATCH ? ${where}
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
      senderName: profiles.get(row.sender_wx_id)?.name ?? row.sender_name ?? "成员",
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
      senderName: profiles.get(m.senderWxId)?.name ?? m.senderName ?? "成员",
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
