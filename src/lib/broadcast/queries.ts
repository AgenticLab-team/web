import "server-only";

import { and, desc, eq, gte, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { broadcastDeliveries, broadcasts, groups, users } from "@/lib/db/schema";
import { paginate, type PageSlice } from "@/lib/pagination";
import { contentHash, statusLabel } from "@/lib/broadcast/rules";
import { resolveDisplayName } from "@/lib/users/display-name";
import { dateKey, startOfDayMs } from "@/lib/time";

/**
 * 群发的读取层。
 *
 * 列表里必须能看出**这条到了哪一步、谁经手过**：
 * 群发是唯一不可撤销的操作，事后追责与事前把关同样重要。
 */

export interface BroadcastRow {
  id: string;
  channel: string;
  title: string | null;
  content: string;
  status: string;
  statusLabel: string;

  createdBy: string;
  createdByName: string;
  approvedBy: string | null;
  approvedByName: string | null;
  approveNote: string | null;

  targetConvIds: string[] | null;
  targetCount: number;
  sentCount: number;
  failedCount: number;
  error: string | null;

  /** 内容在提交复核后被改过 —— 界面上要红 */
  contentDrifted: boolean;

  createdAt: number;
  submittedAt: number | null;
  finishedAt: number | null;
}

export function listBroadcasts(
  query: { channel?: string; status?: string; limit?: number; offset?: number } = {},
): BroadcastRow[] {
  const conditions = [];
  if (query.channel) conditions.push(eq(broadcasts.channel, query.channel as "site"));
  if (query.status) conditions.push(eq(broadcasts.status, query.status as "draft"));

  const rows = db
    .select()
    .from(broadcasts)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(broadcasts.createdAt), desc(broadcasts.id))
    .limit(Math.min(query.limit ?? 50, 200))
    .offset(query.offset ?? 0)
    .all();

  if (rows.length === 0) return [];

  const ids = [
    ...new Set([...rows.map((r) => r.createdBy), ...rows.map((r) => r.approvedBy)].filter(Boolean)),
  ] as string[];

  const names = new Map(
    db
      .select({ id: users.id, site: users.siteNickname, wx: users.wxNickname, wxId: users.wxId })
      .from(users)
      .where(sql`${users.id} in ${ids}`)
      .all()
      .map((u) => [
        u.id,
        resolveDisplayName([u.site, u.wx], { wxId: u.wxId, fallback: "管理员" }),
      ]),
  );

  return rows.map((row) => {
    const targets = Array.isArray(row.targetConvIds) ? (row.targetConvIds as string[]) : null;
    return {
      id: row.id,
      channel: row.channel,
      title: row.title,
      content: row.content,
      status: row.status,
      statusLabel: statusLabel(row.status),

      createdBy: row.createdBy,
      createdByName: names.get(row.createdBy) ?? "管理员",
      approvedBy: row.approvedBy,
      approvedByName: row.approvedBy ? (names.get(row.approvedBy) ?? "管理员") : null,
      approveNote: row.approveNote,

      targetConvIds: targets,
      targetCount: targets?.length ?? 0,
      sentCount: row.sentCount,
      failedCount: row.failedCount,
      error: row.error,

      // 冻结过哈希且现在对不上 —— 这条已经不能再发了
      contentDrifted: row.contentHash !== null && row.contentHash !== contentHash(row.content),

      createdAt: row.createdAt,
      submittedAt: row.submittedAt,
      finishedAt: row.finishedAt,
    };
  });
}

/**
 * 后台「记录」区的分页版。
 *
 * 公告一天最多发几次，但记录**只增不减** —— 一年就是几百条，
 * 静默截断成 30 条的话，「上个月那条发出去了没有」这种问题就查不了了。
 */
export function pagedBroadcasts(
  query: { page?: unknown; perPage?: number } = {},
): { rows: BroadcastRow[]; total: number; slice: PageSlice } {
  const total = Number(db.select({ n: sql<number>`count(*)` }).from(broadcasts).get()?.n ?? 0);
  const slice = paginate(query.page, total, query.perPage ?? 20);
  return { rows: listBroadcasts({ limit: slice.perPage, offset: slice.offset }), total, slice };
}

export function getBroadcast(id: string) {
  return db.select().from(broadcasts).where(eq(broadcasts.id, id)).get() ?? null;
}

export function deliveriesOf(broadcastId: string) {
  return db
    .select()
    .from(broadcastDeliveries)
    .where(eq(broadcastDeliveries.broadcastId, broadcastId))
    .orderBy(broadcastDeliveries.createdAt)
    .all();
}

/** 今天已经发了几次微信群发 —— 频率上限靠它 */
export function sentToday(now = Date.now()): number {
  return db
    .select({ id: broadcasts.id })
    .from(broadcasts)
    .where(
      and(
        eq(broadcasts.channel, "wechat"),
        sql`${broadcasts.status} in ('sending','sent')`,
        gte(broadcasts.startedAt, startOfDayMs(dateKey(now))),
      ),
    )
    .all().length;
}

/** 距上一次微信群发多久。从没发过时返回 null，而不是 0 —— 两者含义完全不同 */
export function msSinceLastSend(now = Date.now()): number | null {
  const last = db
    .select({ startedAt: broadcasts.startedAt })
    .from(broadcasts)
    .where(and(eq(broadcasts.channel, "wechat"), sql`${broadcasts.status} in ('sending','sent')`))
    .orderBy(desc(broadcasts.startedAt))
    .get();

  if (!last?.startedAt) return null;
  return now - last.startedAt;
}

/** 可发送的群 —— 只列本站已接入的，避免发到一个我们自己都不同步的群 */
export function sendableGroups() {
  return db
    .select({ convId: groups.convId, name: groups.name })
    .from(groups)
    .where(and(eq(groups.syncEnabled, true), eq(groups.isGroup, true)))
    .orderBy(desc(groups.messageCount))
    .all();
}

/** 当前生效的站内公告 */
export function activeAnnouncements(now = Date.now()) {
  return db
    .select()
    .from(broadcasts)
    .where(
      and(
        eq(broadcasts.channel, "site"),
        eq(broadcasts.status, "sent"),
        sql`(${broadcasts.expiresAt} is null or ${broadcasts.expiresAt} > ${now})`,
      ),
    )
    .orderBy(desc(broadcasts.createdAt))
    .all();
}
