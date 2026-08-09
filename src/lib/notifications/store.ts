import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { notificationPrefs } from "@/lib/db/schema";
import { defaultPrefs, normalizePrefs, type PrefsMap } from "@/lib/notifications/prefs";

/**
 * 通知偏好的读写。
 *
 * 读的时候永远归一化 —— 加一个新通知类型时，所有老用户的记录里
 * 都缺那一项，而缺项应该按默认（发）处理，不是按 undefined（不发）。
 */

/** 进程内缓存：notify() 每条通知都要查一次，而偏好几乎不变 */
const cache = new Map<string, { prefs: PrefsMap; at: number }>();
const CACHE_TTL_MS = 60_000;

export function getPrefs(userId: string): PrefsMap {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.prefs;

  const row = db
    .select()
    .from(notificationPrefs)
    .where(eq(notificationPrefs.userId, userId))
    .get();

  const prefs = row ? normalizePrefs(row.channels) : defaultPrefs();
  cache.set(userId, { prefs, at: Date.now() });
  return prefs;
}

export function savePrefs(userId: string, prefs: PrefsMap): void {
  db.insert(notificationPrefs)
    .values({ userId, channels: prefs, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: notificationPrefs.userId,
      set: { channels: prefs, updatedAt: Date.now() },
    })
    .run();

  /*
   * 立刻失效，不等 TTL。
   * 用户刚点完「关掉表情通知」又收到一条表情通知的话，
   * 他的结论不会是「缓存一分钟」，而是「这个开关是假的」。
   */
  cache.delete(userId);
}

/** 测试与后台改动后用 */
export function invalidatePrefsCache(userId?: string): void {
  if (userId) cache.delete(userId);
  else cache.clear();
}
