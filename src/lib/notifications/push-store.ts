import "server-only";

import { and, asc, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { pushSubscriptions } from "@/lib/db/schema";
import { b64uDecode } from "@/lib/notifications/webpush";

/**
 * 推送订阅的存取。
 *
 * 订阅数据来自浏览器提交，**每个字段都要按密码学材料的标准校验**：
 * p256dh/auth 存进去是什么样，加密时就用什么样 ——
 * 一条畸形订阅如果在写入时放行，会在每一轮投递里反复抛异常，
 * 而且报错发生在离提交它的那个人最远的地方。
 */

/** 连续失败这么多次就停用 —— 象征意义上的「多给几次机会」，网络抖动不至于误杀 */
const DISABLE_AFTER_FAILS = 8;

/** 一个人最多保留的设备数。超过时挤掉最旧的，而不是拒绝新的 —— 换手机的人不该被旧手机挡住 */
const MAX_PER_USER = 5;

export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string;
}

/** 校验失败返回一句给人看的原因；null 即合格 */
export function validateSubscription(input: PushSubscriptionInput): string | null {
  let url: URL;
  try {
    url = new URL(input.endpoint);
  } catch {
    return "endpoint 不是合法 URL";
  }
  // 明文 endpoint 等于把投递权交给中间人；正经推送服务全是 https
  if (url.protocol !== "https:") return "endpoint 必须是 https";
  if (input.endpoint.length > 1024) return "endpoint 过长";

  const p256dh = b64uDecode(input.p256dh);
  if (p256dh.length !== 65 || p256dh[0] !== 0x04) {
    return "p256dh 不是未压缩 P-256 公钥";
  }
  if (b64uDecode(input.auth).length !== 16) return "auth 不是 16 字节";
  return null;
}

export function savePushSubscription(userId: string, input: PushSubscriptionInput): void {
  db.insert(pushSubscriptions)
    .values({
      userId,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      userAgent: input.userAgent?.slice(0, 200),
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      /*
       * endpoint 撞车意味着同一台设备重新订阅（也可能换了登录人）——
       * 一切以最新提交为准，并清掉失败计数：重新订阅本身就是「我还在」的证明。
       */
      set: {
        userId,
        p256dh: input.p256dh,
        auth: input.auth,
        userAgent: input.userAgent?.slice(0, 200),
        failCount: 0,
        lastError: null,
        disabledAt: null,
      },
    })
    .run();

  const rows = db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId))
    .orderBy(asc(pushSubscriptions.createdAt))
    .all();
  for (const row of rows.slice(0, Math.max(0, rows.length - MAX_PER_USER))) {
    db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, row.id)).run();
  }
}

/** 只删自己名下的 —— endpoint 是用户提交的，不能替别人退订 */
export function removePushSubscription(userId: string, endpoint: string): void {
  db.delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)))
    .run();
}

export function listActivePushSubscriptions(userId: string) {
  return db
    .select()
    .from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), isNull(pushSubscriptions.disabledAt)))
    .all();
}

export function hasActivePushSubscription(userId: string): boolean {
  return listActivePushSubscriptions(userId).length > 0;
}

export function recordPushSuccess(id: string): void {
  db.update(pushSubscriptions)
    .set({ lastOkAt: Date.now(), failCount: 0, lastError: null })
    .where(eq(pushSubscriptions.id, id))
    .run();
}

/**
 * 记一次投递失败。
 *
 * gone（404/410）直接删：推送服务已经明说这个订阅不存在了，留着只会
 * 每一轮都失败一次。其它失败只累计 —— 一次网络抖动就删订阅的话，
 * 用户会在毫不知情的情况下静默掉线，还以为自己订着。
 */
export function recordPushFailure(id: string, error: string, gone: boolean): void {
  if (gone) {
    db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, id)).run();
    return;
  }
  db.update(pushSubscriptions)
    .set({
      failCount: sql`${pushSubscriptions.failCount} + 1`,
      lastError: error.slice(0, 200),
      disabledAt: sql`CASE WHEN ${pushSubscriptions.failCount} + 1 >= ${DISABLE_AFTER_FAILS} THEN ${Date.now()} ELSE ${pushSubscriptions.disabledAt} END`,
    })
    .where(eq(pushSubscriptions.id, id))
    .run();
}

/** 给健康检查一句话：多少订阅在跑、多少已停用 */
export function pushSubscriptionSummary(): { active: number; disabled: number } {
  const row = db
    .select({
      active: sql<number>`SUM(CASE WHEN ${pushSubscriptions.disabledAt} IS NULL THEN 1 ELSE 0 END)`,
      disabled: sql<number>`SUM(CASE WHEN ${pushSubscriptions.disabledAt} IS NOT NULL THEN 1 ELSE 0 END)`,
    })
    .from(pushSubscriptions)
    .get();
  return { active: row?.active ?? 0, disabled: row?.disabled ?? 0 };
}
