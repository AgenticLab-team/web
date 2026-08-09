import "server-only";

import { and, desc, eq, gt, inArray, isNull, like, or, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { resolveDisplayName } from "@/lib/users/display-name";
import {
  checkins,
  credentials,
  groupMembers,
  groups,
  loginAttempts,
  moderationActions,
  people,
  pointsLedger,
  posts,
  replies,
  roles,
  sessions,
  userNotes,
  userRoles,
  users,
} from "@/lib/db/schema";
import { paginate, type PageSlice } from "@/lib/pagination";
import { levelProgress } from "@/lib/points/rules";
import { effectivePermissions } from "@/lib/rbac/can";

/**
 * 用户管理的查询层。
 *
 * 用户详情页要能一眼拼出「这个人是谁、做过什么、被处理过什么」——
 * 信息散在各处的话，处理一次纠纷要开七八个页面，
 * 最后管理员干脆凭印象决定。
 */

export interface UserRow {
  id: string;
  wxId: string | null;
  name: string;
  avatarUrl: string | null;
  kind: string;
  status: string;
  level: number;
  points: number;
  streak: number;
  roleNames: string[];
  groupCount: number;
  lastActiveAt: number | null;
  createdAt: number;
}

export interface UserQuery {
  keyword?: string;
  status?: string;
  kind?: string;
  roleKey?: string;
  /** URL 上的原始 ?page= 值，解析与夹取交给 paginate —— 越界和乱写都要落到有内容的页 */
  page?: unknown;
  perPage?: number;
}

export function listUsers(query: UserQuery = {}): {
  rows: UserRow[];
  total: number;
  slice: PageSlice;
} {
  const conditions = [isNull(users.deletedAt)];

  if (query.keyword) {
    const kw = `%${query.keyword.trim()}%`;
    // 站内昵称、微信昵称、wxid、邮箱、账号 id 都能搜 ——
    /*
     * 管理员手上拿到的线索形态不一定，只支持一种等于逼人去猜。
     *
     * **手机号刻意不在里面**。它是用户填的真实世界身份、没有经过验证，
     * 而且从来不显示给任何人 —— 能用它搜人的话，这个站就成了
     * 一个「手机号 → 这个人是谁」的反查工具。
     */
    conditions.push(
      or(
        like(users.siteNickname, kw),
        like(users.wxNickname, kw),
        like(users.wxId, kw),
        like(users.username, kw),
        like(users.email, kw),
        like(users.id, kw),
      )!,
    );
  }
  if (query.status) conditions.push(eq(users.status, query.status as "active"));
  if (query.kind) conditions.push(eq(users.kind, query.kind as "member"));

  let idFilter: string[] | null = null;
  if (query.roleKey) {
    const role = db.select().from(roles).where(eq(roles.key, query.roleKey)).get();
    idFilter = role
      ? db
          .select({ userId: userRoles.userId })
          .from(userRoles)
          .where(and(eq(userRoles.roleId, role.id), isNull(userRoles.revokedAt)))
          .all()
          .map((r) => r.userId)
      : [];
    // 角色存在但没人持有时给一个不可能匹配的值，避免 inArray 空数组的歧义
    conditions.push(inArray(users.id, idFilter.length ? idFilter : ["__none__"]));
  }

  const where = and(...conditions);
  // 总数单独 count —— 拿全量再数 length 的话，1800 个账号每次都整表进内存
  const total = Number(
    db.select({ n: sql<number>`count(*)` }).from(users).where(where).get()?.n ?? 0,
  );
  const slice = paginate(query.page, total, query.perPage ?? 50);

  const rows = db
    .select()
    .from(users)
    .where(where)
    // 末位补 id 让排序全序：lastActiveAt 为 null 的一批账号顺序不定时，
    // 翻页会出现同一个人出现在两页、另一个人哪页都不在
    .orderBy(desc(users.lastActiveAt), desc(users.createdAt), desc(users.id))
    .limit(slice.perPage)
    .offset(slice.offset)
    .all();

  if (rows.length === 0) return { rows: [], total, slice };

  const ids = rows.map((r) => r.id);
  const wxIds = rows.map((r) => r.wxId).filter(Boolean) as string[];

  const roleMap = new Map<string, string[]>();
  for (const row of db
    .select({ userId: userRoles.userId, name: roles.name, priority: roles.priority })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(inArray(userRoles.userId, ids), isNull(userRoles.revokedAt)))
    .orderBy(desc(roles.priority))
    .all()) {
    if (!roleMap.has(row.userId)) roleMap.set(row.userId, []);
    roleMap.get(row.userId)!.push(row.name);
  }

  const profiles = new Map(
    wxIds.length
      ? db
          .select({ wxId: people.wxId, name: people.displayName, avatar: people.avatarUrl })
          .from(people)
          .where(inArray(people.wxId, wxIds))
          .all()
          .map((p) => [p.wxId, p])
      : [],
  );

  const groupCounts = new Map(
    wxIds.length
      ? db
          .select({ wxId: groupMembers.wxId, n: sql<number>`count(*)` })
          .from(groupMembers)
          .where(and(inArray(groupMembers.wxId, wxIds), isNull(groupMembers.leftAt)))
          .groupBy(groupMembers.wxId)
          .all()
          .map((g) => [g.wxId, Number(g.n)])
      : [],
  );

  return {
    total,
    slice,
    rows: rows.map((row) => ({
      id: row.id,
      wxId: row.wxId,
      name: resolveDisplayName(
        [row.siteNickname, row.wxNickname, row.wxId ? profiles.get(row.wxId)?.name : null],
        { wxId: row.wxId },
      ),
      avatarUrl: row.wxAvatarUrl ?? (row.wxId ? (profiles.get(row.wxId)?.avatar ?? null) : null),
      kind: row.kind,
      status: row.status,
      level: row.level,
      points: row.points,
      streak: row.streakCurrent,
      roleNames: roleMap.get(row.id) ?? [],
      groupCount: row.wxId ? (groupCounts.get(row.wxId) ?? 0) : 0,
      lastActiveAt: row.lastActiveAt,
      createdAt: row.createdAt,
    })),
  };
}

export interface UserDetail {
  user: typeof users.$inferSelect;
  name: string;
  avatarUrl: string | null;
  roles: { id: string; key: string; name: string; color: string | null; scopeId: string | null; expiresAt: number | null }[];
  permissions: { key: string; source: string }[];
  groups: { convId: string; name: string; messages: number; left: boolean }[];
  ledger: (typeof pointsLedger.$inferSelect)[];
  /** 流水与处罚只取最近几条，但总数要一起给 —— 不给的话截断是静默的 */
  ledgerTotal: number;
  moderationTotal: number;
  checkins: number;
  sessions: (typeof sessions.$inferSelect)[];
  credentials: { id: string; type: string; name: string | null; lastUsedAt: number | null }[];
  logins: (typeof loginAttempts.$inferSelect)[];
  moderation: (typeof moderationActions.$inferSelect)[];
  notes: { id: string; content: string; authorId: string; createdAt: number }[];
  forum: { posts: number; replies: number };
  levelProgress: ReturnType<typeof levelProgress>;
}

export function getUserDetail(userId: string): UserDetail | null {
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) return null;

  const profile = user.wxId
    ? db.select().from(people).where(eq(people.wxId, user.wxId)).get()
    : null;

  const held = db
    .select({
      id: userRoles.id,
      key: roles.key,
      name: roles.name,
      color: roles.color,
      scopeId: userRoles.scopeId,
      expiresAt: userRoles.expiresAt,
    })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(userRoles.userId, userId), isNull(userRoles.revokedAt)))
    .orderBy(desc(roles.priority))
    .all();

  const memberships = user.wxId
    ? db
        .select({
          convId: groups.convId,
          name: groups.name,
          messages: groupMembers.messages,
          leftAt: groupMembers.leftAt,
        })
        .from(groupMembers)
        .innerJoin(groups, eq(groups.convId, groupMembers.convId))
        .where(eq(groupMembers.wxId, user.wxId))
        .orderBy(desc(groupMembers.messages))
        .all()
    : [];

  return {
    user,
    name: resolveDisplayName([user.siteNickname, user.wxNickname, profile?.displayName], {
      wxId: user.wxId,
    }),
    avatarUrl: user.wxAvatarUrl ?? profile?.avatarUrl ?? null,
    roles: held,
    permissions: [...effectivePermissions(user)].map(([key, source]) => ({ key, source })),
    groups: memberships.map((m) => ({
      convId: m.convId,
      name: m.name,
      messages: m.messages,
      left: m.leftAt !== null,
    })),
    ledger: db
      .select()
      .from(pointsLedger)
      .where(eq(pointsLedger.userId, userId))
      .orderBy(desc(pointsLedger.createdAt))
      .limit(20)
      .all(),
    ledgerTotal:
      Number(
        db
          .select({ n: sql<number>`count(*)` })
          .from(pointsLedger)
          .where(eq(pointsLedger.userId, userId))
          .get()?.n ?? 0,
      ),
    moderationTotal:
      Number(
        db
          .select({ n: sql<number>`count(*)` })
          .from(moderationActions)
          .where(eq(moderationActions.targetUserId, userId))
          .get()?.n ?? 0,
      ),
    checkins:
      db.select({ n: sql<number>`count(*)` }).from(checkins).where(eq(checkins.userId, userId)).get()
        ?.n ?? 0,
    sessions: db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.expiresAt, Date.now())))
      .orderBy(desc(sessions.lastSeenAt))
      .all(),
    credentials: db
      .select({
        id: credentials.id,
        type: credentials.type,
        name: credentials.name,
        lastUsedAt: credentials.lastUsedAt,
      })
      .from(credentials)
      .where(and(eq(credentials.userId, userId), isNull(credentials.revokedAt)))
      .all(),
    logins: db
      .select()
      .from(loginAttempts)
      .where(eq(loginAttempts.userId, userId))
      .orderBy(desc(loginAttempts.createdAt))
      .limit(10)
      .all(),
    moderation: db
      .select()
      .from(moderationActions)
      .where(eq(moderationActions.targetUserId, userId))
      .orderBy(desc(moderationActions.createdAt))
      .limit(20)
      .all(),
    notes: db
      .select({
        id: userNotes.id,
        content: userNotes.content,
        authorId: userNotes.authorId,
        createdAt: userNotes.createdAt,
      })
      .from(userNotes)
      .where(and(eq(userNotes.userId, userId), isNull(userNotes.deletedAt)))
      .orderBy(desc(userNotes.createdAt))
      .all(),
    forum: {
      posts:
        db.select({ n: sql<number>`count(*)` }).from(posts).where(eq(posts.authorId, userId)).get()
          ?.n ?? 0,
      replies:
        db
          .select({ n: sql<number>`count(*)` })
          .from(replies)
          .where(eq(replies.authorId, userId))
          .get()?.n ?? 0,
    },
    levelProgress: levelProgress(user.pointsTotal),
  };
}

/** 状态分布，用于列表页顶部的筛选快捷入口 */
export function userFacets() {
  const byStatus = db
    .select({ status: users.status, n: sql<number>`count(*)` })
    .from(users)
    .where(isNull(users.deletedAt))
    .groupBy(users.status)
    .all();

  const byRole = db
    .select({ key: roles.key, name: roles.name, n: sql<number>`count(*)` })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(isNull(userRoles.revokedAt))
    .groupBy(roles.key, roles.name)
    .orderBy(desc(roles.priority))
    .all();

  return {
    status: byStatus.map((r) => ({ value: r.status, count: Number(r.n) })),
    roles: byRole.map((r) => ({ key: r.key, name: r.name, count: Number(r.n) })),
  };
}
