import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";

import { db, sqlite } from "@/lib/db";
import { groupMembers, keywordHits, keywordSubs, users } from "@/lib/db/schema";
import { notify } from "@/lib/forum/notify";
import { isModuleEnabled } from "@/lib/modules/state";
import {
  highlight,
  isNewDay,
  matchesKeyword,
  shouldNotify,
} from "@/lib/radar/match";

/**
 * 关键词雷达。同步写完一批消息之后跑一次。
 *
 * ─────────────────────────────────────────
 * 一条划死的线
 * ─────────────────────────────────────────
 *
 * **只在订阅者自己所在的群里匹配。**
 * 否则这就不是雷达，是一个可以监听任意群的工具 ——
 * 而那个工具一旦存在，「我在哪个群」这件事就没有意义了。
 *
 * 检查放在**匹配之前**：先算出这个人看得到哪些群，再拿他的词去比。
 * 反过来（先匹配、再过滤）也能得到同样的结果，但那样的代码里，
 * 漏掉一次过滤就是一次静默泄露。
 */

export interface RadarMessage {
  id: string;
  convId: string;
  content: string;
  ts: number;
  senderWxId: string | null;
  senderName: string | null;
  type: string;
}

export interface RadarResult {
  scanned: number;
  hits: number;
  notified: number;
  /** 命中了但被日封顶压掉的 —— 要能看出「其实响了很多次」 */
  suppressed: number;
}

const MATCHABLE_TYPES = new Set(["text", "quote"]);

interface Watcher {
  subId: string;
  userId: string;
  wxId: string | null;
  keyword: string;
  keywordKey: string;
  hitsToday: number;
  lastNotifiedAt: number | null;
  convIds: Set<string>;
}

/** 取出所有启用中的订阅，连同订阅者看得到的群 */
function loadWatchers(): Watcher[] {
  const subs = db
    .select({
      subId: keywordSubs.id,
      userId: keywordSubs.userId,
      keyword: keywordSubs.keyword,
      keywordKey: keywordSubs.keywordKey,
      hitsToday: keywordSubs.hitsToday,
      lastNotifiedAt: keywordSubs.lastNotifiedAt,
      wxId: users.wxId,
    })
    .from(keywordSubs)
    .innerJoin(users, eq(users.id, keywordSubs.userId))
    .where(and(eq(keywordSubs.enabled, true), eq(users.status, "active")))
    .all();

  if (subs.length === 0) return [];

  // 一次把所有人的群捞出来，避免逐个订阅去查
  const memberships = db
    .select({ wxId: groupMembers.wxId, convId: groupMembers.convId })
    .from(groupMembers)
    .where(isNull(groupMembers.leftAt))
    .all();

  const byWxId = new Map<string, Set<string>>();
  for (const row of memberships) {
    const set = byWxId.get(row.wxId) ?? new Set<string>();
    set.add(row.convId);
    byWxId.set(row.wxId, set);
  }

  return subs.map((sub) => ({
    ...sub,
    convIds: sub.wxId ? (byWxId.get(sub.wxId) ?? new Set<string>()) : new Set<string>(),
  }));
}

export function scanMessages(rows: RadarMessage[], now = Date.now()): RadarResult {
  const result: RadarResult = { scanned: 0, hits: 0, notified: 0, suppressed: 0 };
  // 关掉之后不再扫、不再通知；已有的订阅与命中记录都留着
  if (!isModuleEnabled("radar")) return result;
  if (rows.length === 0) return result;

  const watchers = loadWatchers();
  if (watchers.length === 0) return result;

  for (const message of rows) {
    if (!MATCHABLE_TYPES.has(message.type)) continue;
    result.scanned++;

    for (const watcher of watchers) {
      // 可见性先判，再匹配 —— 顺序反过来的代码，漏一次过滤就是一次泄露
      if (!watcher.convIds.has(message.convId)) continue;
      // 自己说的话不该提醒自己
      if (message.senderWxId && message.senderWxId === watcher.wxId) continue;
      if (!matchesKeyword(message.content, watcher.keywordKey)) continue;

      const recorded = recordHit(watcher, message, now, result);
      if (!recorded) continue;
    }
  }

  return result;
}

function recordHit(
  watcher: Watcher,
  message: RadarMessage,
  now: number,
  result: RadarResult,
): boolean {
  /*
   * 命中记录先落库、靠唯一索引去重。
   * 「先查再写」在同步与回填同时跑的时候会两边都插进去，
   * 而重复的命中会让 total_hits 虚高 —— 一个没人会怀疑的数字。
   */
  const inserted = db
    .insert(keywordHits)
    .values({
      subId: watcher.subId,
      messageId: message.id,
      convId: message.convId,
      senderName: message.senderName,
      snippet: highlight(message.content, watcher.keywordKey),
      notified: false,
      hitAt: message.ts,
    })
    .onConflictDoNothing()
    .run();

  if (inserted.changes === 0) return false;
  result.hits++;

  // 跨天了就把日计数清零 —— 一次热闹不该让这个订阅永远失效
  const hitsToday = isNewDay(watcher.lastNotifiedAt, now) ? 0 : watcher.hitsToday;

  const verdict = shouldNotify({
    hitsToday,
    lastNotifiedAt: isNewDay(watcher.lastNotifiedAt, now) ? null : watcher.lastNotifiedAt,
    now,
  });

  db.update(keywordSubs)
    .set({ totalHits: sql`${keywordSubs.totalHits} + 1`, hitsToday })
    .where(eq(keywordSubs.id, watcher.subId))
    .run();

  if (!verdict.notify) {
    result.suppressed++;
    return true;
  }

  notify({
    userId: watcher.userId,
    type: "keyword",
    // 同一个词的多次命中合并成一条 —— 不合并的话一次讨论就是一串通知
    groupKey: `keyword:${watcher.subId}`,
    title: `群里提到了「${watcher.keyword}」`,
    body: highlight(message.content, watcher.keywordKey) ?? undefined,
    link: `/radar?k=${encodeURIComponent(watcher.subId)}`,
    actorName: message.senderName ?? undefined,
    refType: "keyword",
    refId: watcher.subId,
  });

  db.update(keywordSubs)
    .set({ hitsToday: hitsToday + 1, lastNotifiedAt: now })
    .where(eq(keywordSubs.id, watcher.subId))
    .run();

  db.update(keywordHits)
    .set({ notified: true })
    .where(and(eq(keywordHits.subId, watcher.subId), eq(keywordHits.messageId, message.id)))
    .run();

  // 内存里的 watcher 也要跟上，否则同一批消息里会连发
  watcher.hitsToday = hitsToday + 1;
  watcher.lastNotifiedAt = now;

  result.notified++;
  return true;
}

/**
 * 预估一个词会有多吵：过去七天在**这个人看得到的群里**命中几次。
 *
 * 范围必须和真正匹配时一致 —— 用全站消息去估的话，
 * 一个只在别的群火的词会被估成「很吵」而其实一次都不会响，
 * 反过来也一样。估不准的预估比没有预估更容易让人做错决定。
 */
export function estimateHits7d(userId: string, keyword: string, now = Date.now()): number {
  const user = db.select({ wxId: users.wxId }).from(users).where(eq(users.id, userId)).get();
  if (!user?.wxId) return 0;

  const convIds = db
    .select({ convId: groupMembers.convId })
    .from(groupMembers)
    .where(and(eq(groupMembers.wxId, user.wxId), isNull(groupMembers.leftAt)))
    .all()
    .map((g) => g.convId);

  if (convIds.length === 0) return 0;

  const placeholders = convIds.map(() => "?").join(",");
  const rows = sqlite
    .prepare(
      `SELECT content FROM messages
       WHERE conv_id IN (${placeholders})
         AND ts >= ?
         AND type IN ('text','quote')
         AND content != ''
       LIMIT 20000`,
    )
    .all(...convIds, now - 7 * 86_400_000) as { content: string }[];

  let hits = 0;
  for (const row of rows) if (matchesKeyword(row.content, keyword)) hits++;
  return hits;
}
