import "server-only";

import { and, count, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";

import type { CurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import {
  announcementDismissals,
  broadcasts,
  groupMembers,
  groups,
  roles,
  userRoles,
  users,
} from "@/lib/db/schema";
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

/**
 * 这个人在哪些群里。
 *
 * ─────────────────────────────────────────
 * 故意**不用** `visibleGroupIds`
 * ─────────────────────────────────────────
 *
 * 那个函数回答的是「哪些群的**消息**他看得到」，因此要求
 * `sync_enabled` —— 而同步开关管的是消息归档，不是群还存不存在。
 * 一个没开同步的群，里面的人照样在用这个站，
 * 照样该看得到发给他们的公告。
 *
 * 更要紧的是**两边必须用同一个口径**：`audienceSize()` 按群成员算。
 * 这里如果按「消息可见」算，后台会显示「发给 30 个人」
 * 而实际一个人都没看到 —— 那正是这个功能最坏的失败方式，
 * 因为管理员看到那个数字之后就不会再核对了。
 */
function myGroupConvIds(user: CurrentUser): string[] {
  if (!user.wxId) return [];
  return db
    .select({ convId: groupMembers.convId })
    .from(groupMembers)
    .where(and(eq(groupMembers.wxId, user.wxId), isNull(groupMembers.leftAt)))
    .all()
    .map((m) => m.convId);
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
      targetConvIds: broadcasts.targetConvIds,
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

  /*
   * 群同理：只有真有按群定向的公告时才去查这个人在哪些群。
   * 绝大多数公告是全站的，这一查大多数时候可以省掉。
   */
  const needsGroups = live.some((a) => {
    const ids = a.targetConvIds as string[] | null;
    return Array.isArray(ids) && ids.length > 0;
  });
  const myConvIds = needsGroups ? myGroupConvIds(user) : [];

  const mine = live.filter(
    (a) =>
      isLive(a, now) &&
      targeted(
        { targetRoleId: a.targetRoleId, targetConvIds: a.targetConvIds as string[] | null },
        myRoleIds,
        myConvIds,
      ),
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
/**
 * 这条公告实际会送到几个人。
 *
 * ─────────────────────────────────────────
 * 两个条件取交集，所以不能各算各的
 * ─────────────────────────────────────────
 *
 * 分开算再相加会得出一个比真实值大得多的数 ——
 * 而管理员看到「发给 116 个人」之后就不会再核对了。
 * **一个偏大的受众数比没有这个数更坏**：它让人以为通知到位了。
 *
 * 所以这里按人去算：拿到符合条件的用户 id 集合，取交集，数大小。
 * 一百多人的站，这么算比拼 SQL 清楚得多，也不会算错。
 */
export function audienceSize(
  targetRoleId: string | null,
  targetConvIds: string[] | null = null,
): number {
  const active = new Set(
    db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.status, "active"))
      .all()
      .map((u) => u.id),
  );

  if (targetRoleId) {
    const holders = new Set(
      db
        .select({ userId: userRoles.userId })
        .from(userRoles)
        .where(and(eq(userRoles.roleId, targetRoleId), isNull(userRoles.revokedAt)))
        .all()
        .map((r) => r.userId),
    );
    for (const id of active) if (!holders.has(id)) active.delete(id);
  }

  if (targetConvIds && targetConvIds.length > 0) {
    /*
     * 群成员是按 wx_id 记的，不是 user_id —— 中间要过一次映射。
     * 已经退群的（`left_at` 非空）不算：一条发给 A 群的公告
     * 不该出现在上个月退群的人面前。
     */
    const wxIds = new Set(
      db
        .select({ wxId: groupMembers.wxId })
        .from(groupMembers)
        .where(and(inArray(groupMembers.convId, targetConvIds), isNull(groupMembers.leftAt)))
        .all()
        .map((m) => m.wxId),
    );
    const inGroups = new Set(
      db
        .select({ id: users.id, wxId: users.wxId })
        .from(users)
        .all()
        .filter((u) => u.wxId && wxIds.has(u.wxId))
        .map((u) => u.id),
    );
    for (const id of active) if (!inGroups.has(id)) active.delete(id);
  }

  return active.size;
}

/**
 * 可以拿来定向的群。
 *
 * 只列**已接入且还有人**的 —— 一个空群出现在选项里，
 * 选中它的结果是「发给 0 个人」，而那句话要等到发完才看得到。
 */
export function targetableGroups() {
  const counts = db
    .select({ convId: groupMembers.convId, n: count() })
    .from(groupMembers)
    .where(isNull(groupMembers.leftAt))
    .groupBy(groupMembers.convId)
    .all();
  const byConv = new Map(counts.map((c) => [c.convId, Number(c.n)]));

  return db
    .select({ convId: groups.convId, name: groups.name })
    .from(groups)
    .all()
    .map((g) => ({ ...g, members: byConv.get(g.convId) ?? 0 }))
    .filter((g) => g.members > 0)
    .sort((a, b) => b.members - a.members);
}

/** 群名，用来在后台把「发给谁」讲清楚 */
export function groupNamesOf(convIds: string[] | null): string[] {
  if (!convIds || convIds.length === 0) return [];
  return db
    .select({ convId: groups.convId, name: groups.name })
    .from(groups)
    .where(inArray(groups.convId, convIds))
    .all()
    .map((g) => g.name ?? g.convId);
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
