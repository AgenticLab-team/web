import "server-only";

import { and, count, eq, isNull, notInArray, or, sql } from "drizzle-orm";

import type { CurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { announcementDismissals, broadcasts, roles, userRoles } from "@/lib/db/schema";
import { isLive, pickVisible, targeted } from "@/lib/broadcast/announce-rules";

/**
 * 现在该给这个人看的站内公告。
 *
 * ─────────────────────────────────────────
 * 这个查询在每一页都会跑
 * ─────────────────────────────────────────
 *
 * 它挂在 AppShell 上，所以每一次页面渲染都要问一遍。
 * 而绝大多数时候答案是「没有」—— 所以第一件事是用一条便宜的
 * 查询把「一条生效中的公告都没有」这种情况尽快判掉，
 * 不要为了一个空结果去 join 身份组和已关闭记录。
 */

export interface LiveAnnouncement {
  id: string;
  title: string | null;
  content: string;
  display: string | null;
  createdAt: number;
  expiresAt: number | null;
}

export function announcementsFor(
  user: CurrentUser | null,
  now = Date.now(),
): { modal: LiveAnnouncement | null; banners: LiveAnnouncement[] } {
  const empty = { modal: null, banners: [] as LiveAnnouncement[] };

  /*
   * 未登录访客不看公告。
   *
   * 他没有身份，也就没有「已读」可言 —— 那条横幅每次刷新都回来，
   * 而他没有任何办法关掉。一个关不掉的横幅，两次之后人就不再读它了，
   * 于是真正要紧的那条也一起被无视。
   */
  if (!user) return empty;

  const live = db
    .select({
      id: broadcasts.id,
      title: broadcasts.title,
      content: broadcasts.content,
      display: broadcasts.display,
      createdAt: broadcasts.createdAt,
      expiresAt: broadcasts.expiresAt,
      targetRoleId: broadcasts.targetRoleId,
    })
    .from(broadcasts)
    .where(
      and(
        eq(broadcasts.channel, "site"),
        eq(broadcasts.status, "sent"),
        or(isNull(broadcasts.expiresAt), sql`${broadcasts.expiresAt} > ${now}`),
        // 关掉过的不再出现。子查询而不是 leftJoin —— 后者在没有
        // 关闭记录时会因为 null 比较写错，而写错的方向是「全都不显示」
        notInArray(
          broadcasts.id,
          db
            .select({ id: announcementDismissals.broadcastId })
            .from(announcementDismissals)
            .where(eq(announcementDismissals.userId, user.id)),
        ),
      ),
    )
    .all();

  if (live.length === 0) return empty;

  // 到这一步才去查身份组 —— 上面那条空结果的路径占绝大多数
  const myRoleIds = db
    .select({ roleId: userRoles.roleId })
    .from(userRoles)
    .where(and(eq(userRoles.userId, user.id), isNull(userRoles.revokedAt)))
    .all()
    .map((r) => r.roleId);

  const mine = live.filter(
    (a) => isLive(a, now) && targeted(a, myRoleIds),
  );

  return pickVisible(mine);
}

/** 把一条公告关掉。主键去重，重复点不会插两行 */
export function dismissAnnouncement(userId: string, broadcastId: string): void {
  db.insert(announcementDismissals)
    .values({ userId, broadcastId, dismissedAt: Date.now() })
    .onConflictDoNothing()
    .run();
}

/**
 * 后台要看的：这条公告有多少人关掉了。
 *
 * 「有没有人看见」这个问题只有这一个答案能回答 ——
 * 我们不记「谁看过」（见 schema 里的说明），
 * 而点了关的人一定是看见了。
 */
export function dismissedCount(broadcastId: string): number {
  return (
    db
      .select({ n: count() })
      .from(announcementDismissals)
      .where(eq(announcementDismissals.broadcastId, broadcastId))
      .get()?.n ?? 0
  );
}

/**
 * 这条公告发给了多少人。
 *
 * 定向的按身份组算，全体的按「有登录能力的活跃用户」算。
 * 后台要它来回答「我是不是选错了身份组」—— 发出去之后
 * 界面上只写「已发布」的话，选错的表现是「大家都说没收到」，
 * 而那时候已经晚了。
 */
export function audienceSize(targetRoleId: string | null): number {
  if (!targetRoleId) {
    return (
      db
        .select({ n: count() })
        .from(sql`users`)
        .where(sql`status = 'active'`)
        .get()?.n ?? 0
    );
  }
  return (
    db
      .select({ n: count() })
      .from(userRoles)
      .where(and(eq(userRoles.roleId, targetRoleId), isNull(userRoles.revokedAt)))
      .get()?.n ?? 0
  );
}

/** 可以定向到的身份组，给后台的下拉用 */
export function targetableRoles() {
  return db
    .select({ id: roles.id, name: roles.name, key: roles.key })
    .from(roles)
    .orderBy(roles.priority)
    .all();
}

export function roleNameOf(roleId: string | null): string | null {
  if (!roleId) return null;
  return db.select({ name: roles.name }).from(roles).where(eq(roles.id, roleId)).get()?.name ?? null;
}
