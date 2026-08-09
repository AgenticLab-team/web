import "server-only";

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { notifications, posts, subscriptions, users } from "@/lib/db/schema";
import {
  FILTER_LABELS,
  TYPE_FILTERS,
  filterTypes,
  isEnabled,
  type NotificationFilter,
} from "@/lib/notifications/prefs";
import { getPrefs } from "@/lib/notifications/store";

import { buildViewerContext } from "./context";
import { noticeCopy, pickSource, type FollowTarget } from "./follow-rules";
import { toVisibilityInfo } from "./queries";
import { canSeePost } from "./visibility";

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
  | "system"
  | "keyword"
  | "new_post";

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
  /**
   * 合并后的标题怎么写。不传就用通用那套（「张三等 3 人…」）。
   *
   * 通用那套假设标题以人名开头 —— 「关注的版块有新帖」这类标题
   * 套上去会变成「某人等 2 人综合讨论有新帖」，不成句。
   */
  aggregate?: (count: number) => string;
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

  /*
   * 用户关掉的类型**不产生这一行**，而不是产生了再在读的时候过滤。
   *
   * 存下来再过滤看起来更灵活（打开开关能补看历史），实际上是个陷阱：
   * 未读数、红点、聚合计数全都要跟着记住「这条对这个人不算数」，
   * 而其中任何一处漏了，用户就会看到一个点不掉的红点。
   *
   * 关掉的代价是那段时间的通知真的没有了 —— 这符合直觉，
   * 也是「关掉」这个词本来的意思。
   */
  if (!isEnabled(getPrefs(input.userId), input.type)) return;

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
        title: input.aggregate
          ? input.aggregate(existing.count + 1)
          : aggregateTitle(input.title, input.actorName ?? null, existing.count + 1),
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

export function listNotifications(
  userId: string,
  limit = 30,
  filter: NotificationFilter = "all",
) {
  const conditions = [eq(notifications.userId, userId)];

  /*
   * 筛选在 SQL 里做，不是取 50 条回来再过滤。
   * 后者的表现是「@ 我」那一页明明有内容却显示空 ——
   * 因为最近 50 条里恰好一条都不是 @。
   */
  if (filter === "unread") conditions.push(isNull(notifications.readAt));
  const types = filterTypes(filter);
  if (types) conditions.push(inArray(notifications.type, types as NotificationType[]));

  return db
    .select()
    .from(notifications)
    .where(and(...conditions))
    .orderBy(desc(notifications.updatedAt))
    .limit(limit)
    .all();
}

/** 每个筛选页签下有多少条 —— 空页签要能提前看出来，而不是点进去才发现 */
export function notificationCounts(userId: string): Record<NotificationFilter, number> {
  const rows = db
    .select({ type: notifications.type, readAt: notifications.readAt })
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .all();

  // 页签清单从 FILTER_TYPES 推，不再手写 —— 手写的那份漏掉一个页签，
  // 表现是那一格计数永远是 0：看起来是空的，点进去却有东西
  const counts = Object.fromEntries(
    (Object.keys(FILTER_LABELS) as NotificationFilter[]).map((key) => [key, 0]),
  ) as Record<NotificationFilter, number>;

  counts.all = rows.length;
  for (const row of rows) {
    if (row.readAt === null) counts.unread++;
    for (const key of TYPE_FILTERS) {
      if (filterTypes(key)?.includes(row.type)) counts[key]++;
    }
  }
  return counts;
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

/**
 * 关注的作者 / 版块 / 标签发了新帖。
 *
 * ─────────────────────────────────────────
 * 在这个函数之前，发新帖不通知任何人
 * ─────────────────────────────────────────
 *
 * 站里只有 `notifyNewReply`。`subscriptions.target_type` 从一开始
 * 就写着 `post | board | tag | user`，而另外三个值从来没有一行数据 ——
 * 因为没有任何东西会去读它们。
 *
 * ─────────────────────────────────────────
 * 逐人判可见性，这一条不能省
 * ─────────────────────────────────────────
 *
 * 这条通知带着**标题**和链接，发给的是订阅者，
 * 而订阅者不等于有权看的人。少了这一步，一个「仅自己可见」
 * 或者限定身份的帖子，标题就直接出现在所有粉丝的通知栏里 ——
 * 通知本身就是泄露，点不点进去都一样。
 *
 * 代价是每个收件人一次 `buildViewerContext`（角色 + 可见群）。
 * 关注上限（见 follow-rules）压着人数，而这笔开销买的是
 * 「不会把私密帖标题群发出去」——没有比这更值得花的查询。
 */
export function notifyNewPost(input: {
  postId: string;
  title: string;
  authorId: string;
  /** 匿名帖必须传 null —— 见下面那段 */
  authorName: string | null;
  boardId: string;
  boardName: string;
  tagIds?: string[];
}) {
  const post = db.select().from(posts).where(eq(posts.id, input.postId)).get();
  if (!post) return;

  // 草稿、待审、定时未到的都不扇出 —— 只有真的发出来的帖子才算发生了
  if (post.status !== "published" || post.deletedAt) return;

  /*
   * 匿名帖跳过「关注作者」那一路。
   *
   * 收件人名单本身就是答案：「你关注的张三发了新帖」+ 一个匿名帖的
   * 链接，匿名当场失效。版块和标签那两路还发，但作者名一律抹掉。
   */
  const anonymous = post.anonymous;
  const authorName = anonymous ? null : input.authorName;

  /** userId -> 命中了哪几种关注 */
  const hits = new Map<string, FollowTarget[]>();
  const add = (userId: string, target: FollowTarget) => {
    if (userId === input.authorId) return; // 自己发的不通知自己
    const list = hits.get(userId);
    if (list) list.push(target);
    else hits.set(userId, [target]);
  };

  const rowsFor = (targetType: FollowTarget, targetIds: string[]) =>
    targetIds.length
      ? db
          .select({ userId: subscriptions.userId })
          .from(subscriptions)
          .where(
            and(
              eq(subscriptions.targetType, targetType),
              inArray(subscriptions.targetId, targetIds),
              isNull(subscriptions.mutedAt),
            ),
          )
          .all()
      : [];

  if (!anonymous) {
    for (const row of rowsFor("user", [input.authorId])) add(row.userId, "user");
  }
  for (const row of rowsFor("board", [input.boardId])) add(row.userId, "board");
  for (const row of rowsFor("tag", input.tagIds ?? [])) add(row.userId, "tag");

  if (hits.size === 0) return;

  const info = toVisibilityInfo(post);
  const recipients = db
    .select()
    .from(users)
    .where(inArray(users.id, [...hits.keys()]))
    .all();

  for (const user of recipients) {
    // 已经不能登录的人不必再收通知
    if (user.status !== "active") continue;

    // 这一步就是上面说的那一步
    if (!canSeePost(info, buildViewerContext(user, input.boardId)).visible) continue;

    const source = pickSource(hits.get(user.id) ?? []);
    if (!source) continue;

    const sourceId =
      source === "user" ? input.authorId : source === "board" ? input.boardId : (input.tagIds?.[0] ?? "");
    const sourceName = source === "board" ? input.boardName : (authorName ?? input.boardName);

    const copy = noticeCopy({ source, sourceId, sourceName, authorName });

    notify({
      userId: user.id,
      type: "new_post",
      groupKey: copy.groupKey,
      title: copy.title,
      aggregate: copy.aggregate,
      body: input.title,
      link: `/forum/p/${input.postId}`,
      /*
       * 匿名帖不带 actor。
       *
       * actorId / actorName 会渲染成通知里的头像和名字 ——
       * 传了就等于在通知栏里指名道姓，而这个帖子是匿名的。
       */
      actorId: anonymous ? undefined : input.authorId,
      actorName: authorName ?? undefined,
      refType: "post",
      refId: input.postId,
    });
  }
}
