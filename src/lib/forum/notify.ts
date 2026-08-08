import "server-only";

import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { notifications, subscriptions } from "@/lib/db/schema";

/**
 * 通知与聚合。
 *
 * 不聚合的话，一个热帖能瞬间刷出几十条通知，
 * 用户的应对方式是直接把通知关掉 —— 那就等于一条都没发。
 *
 * 聚合规则：**同一个聚合键的未读通知合并成一条**，count 累加，
 * 时间刷新到最新。已读的不再合并 —— 用户已经看过了，
 * 新的动静应该重新冒出来，而不是悄悄改掉一条他已读的。
 */

export type NotificationType =
  | "mention"
  | "reply_to_post"
  | "reply_to_reply"
  | "subscribed_reply"
  | "reaction"
  | "featured"
  | "accepted"
  | "moderation"
  | "system";

export interface NotifyInput {
  userId: string;
  type: NotificationType;
  /** 同键的未读通知会被合并 */
  groupKey: string;
  title: string;
  body?: string;
  link?: string;
  actorId?: string;
  actorName?: string;
  refType?: string;
  refId?: string;
}

/** 合并后的标题：「张三等 3 人回复了你的帖子」 */
export function aggregateTitle(baseTitle: string, actorName: string | null, count: number): string {
  if (count <= 1) return baseTitle;
  const who = actorName ? `${actorName}等 ${count} 人` : `${count} 人`;
  // baseTitle 形如「张三回复了你的帖子」，把开头的人名换成聚合说法
  const action = actorName && baseTitle.startsWith(actorName)
    ? baseTitle.slice(actorName.length)
    : baseTitle;
  return `${who}${action}`;
}

export function notify(input: NotifyInput): void {
  // 不给自己发通知 —— 自己回自己的帖子不该冒红点
  if (input.actorId && input.actorId === input.userId) return;

  const existing = db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, input.userId),
        eq(notifications.groupKey, input.groupKey),
        isNull(notifications.readAt),
      ),
    )
    .get();

  if (existing) {
    db.update(notifications)
      .set({
        count: sql`${notifications.count} + 1`,
        title: aggregateTitle(input.title, input.actorName ?? null, existing.count + 1),
        body: input.body,
        link: input.link ?? existing.link,
        actorId: input.actorId,
        actorName: input.actorName,
        updatedAt: Date.now(),
      })
      .where(eq(notifications.id, existing.id))
      .run();
    return;
  }

  db.insert(notifications)
    .values({
      userId: input.userId,
      type: input.type,
      groupKey: input.groupKey,
      title: input.title,
      body: input.body,
      link: input.link,
      actorId: input.actorId,
      actorName: input.actorName,
      refType: input.refType,
      refId: input.refId,
    })
    .run();
}

/**
 * 帖子有新回复时，通知作者与订阅者。
 * 三者可能重叠（作者通常也订阅了自己的帖子），所以要去重 ——
 * 否则同一件事发两条通知。
 */
export function notifyNewReply(input: {
  postId: string;
  postTitle: string;
  postAuthorId: string;
  replyAuthorId: string;
  replyAuthorName: string;
  floor: number;
  mentions: string[];
}) {
  const link = `/forum/p/${input.postId}#f${input.floor}`;
  const notified = new Set<string>([input.replyAuthorId]);

  // 被 @ 的人优先级最高，单独一条，不与普通回复合并
  for (const userId of input.mentions) {
    if (notified.has(userId)) continue;
    notified.add(userId);
    notify({
      userId,
      type: "mention",
      groupKey: `mention:${input.postId}`,
      title: `${input.replyAuthorName}在回复中提到了你`,
      body: input.postTitle,
      link,
      actorId: input.replyAuthorId,
      actorName: input.replyAuthorName,
      refType: "post",
      refId: input.postId,
    });
  }

  if (!notified.has(input.postAuthorId)) {
    notified.add(input.postAuthorId);
    notify({
      userId: input.postAuthorId,
      type: "reply_to_post",
      groupKey: `reply:${input.postId}`,
      title: `${input.replyAuthorName}回复了你的帖子`,
      body: input.postTitle,
      link,
      actorId: input.replyAuthorId,
      actorName: input.replyAuthorName,
      refType: "post",
      refId: input.postId,
    });
  }

  const subscribers = db
    .select({ userId: subscriptions.userId })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.targetType, "post"),
        eq(subscriptions.targetId, input.postId),
        isNull(subscriptions.mutedAt),
      ),
    )
    .all();

  for (const sub of subscribers) {
    if (notified.has(sub.userId)) continue;
    notified.add(sub.userId);
    notify({
      userId: sub.userId,
      type: "subscribed_reply",
      groupKey: `sub:${input.postId}`,
      title: `${input.replyAuthorName}回复了你关注的帖子`,
      body: input.postTitle,
      link,
      actorId: input.replyAuthorId,
      actorName: input.replyAuthorName,
      refType: "post",
      refId: input.postId,
    });
  }
}

export function unreadCount(userId: string): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
      .get()?.n ?? 0
  );
}

export function listNotifications(userId: string, limit = 30) {
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.updatedAt))
    .limit(limit)
    .all();
}

export function markRead(userId: string, notificationId?: string) {
  const conditions = [eq(notifications.userId, userId), isNull(notifications.readAt)];
  if (notificationId) conditions.push(eq(notifications.id, notificationId));
  return db.update(notifications).set({ readAt: Date.now() }).where(and(...conditions)).run();
}

/** 发帖或回帖后自动订阅。用户手动退订过就不再自动订阅回来 */
export function autoSubscribe(userId: string, postId: string) {
  const existing = db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, userId),
        eq(subscriptions.targetType, "post"),
        eq(subscriptions.targetId, postId),
      ),
    )
    .get();

  // 已经存在（含已静音）就不动它 —— 退订过的人不该被重新订阅回来
  if (existing) return;

  db.insert(subscriptions)
    .values({ userId, targetType: "post", targetId: postId, auto: true })
    .run();
}

export function isSubscribed(userId: string, postId: string): boolean {
  const row = db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, userId),
        eq(subscriptions.targetType, "post"),
        eq(subscriptions.targetId, postId),
        isNull(subscriptions.mutedAt),
      ),
    )
    .get();
  return Boolean(row);
}
