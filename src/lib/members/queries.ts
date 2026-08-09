import "server-only";

import { and, eq, inArray, isNull, ne } from "drizzle-orm";

import type { CurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { groupMembers, people, userSkills, users } from "@/lib/db/schema";
import { paletteIndexFor } from "@/components/Avatar";
import { isModuleEnabled } from "@/lib/modules/state";
import { preferredLabel, visibleFacets, type TagFacet } from "@/lib/members/tags";
import { equippedTitles } from "@/lib/titles/queries";
import { resolveDisplayName } from "@/lib/users/display-name";

/**
 * 成员目录。
 *
 * ─────────────────────────────────────────
 * 两条划死的线
 * ─────────────────────────────────────────
 *
 * **① 只收录注册用户，不收录群成员表。**
 * `people` 里有一千八百人，`users` 里只有二十几个。
 * 一个人出现在群成员表里，是微信群的事实；把他放进一个
 * 可按技能检索的网页名录，是这个站替他做的公开 —— 他没同意过。
 * 目录小得多，但小的那个是真的。
 *
 * **② 只看得到和你同群的人。**
 * 「群列表属于隐私」这条规矩往下推一层就是成员：
 * 不同群的人之间，这个站不该充当互相发现的渠道。
 * 所以目录按**共同群**过滤，而且不显示是哪个群 ——
 * 显示了就等于把群名泄露给了另一个群的人。
 */

export interface DirectoryMember {
  id: string;
  name: string;
  avatarUrl: string | null;
  /**
   * 配色下标，不是 wx_id。
   *
   * 占位头像的颜色由 wx_id 决定（同一个人跨页面不跳变），但 wx_id
   * 本身不该出现在这个结构里 —— 它会被序列化进 RSC 载荷、
   * 出现在网页源码里。一个只用来算颜色的值不值得冒这个险。
   */
  paletteIndex: number;
  bio: string | null;
  title: { name: string; icon: string | null; rarity: string } | null;
  tags: { slug: string; label: string }[];
  /** 和你共同在几个群 —— 只说数量，不说是哪个 */
  sharedGroups: number;
  points: number;
  isMe: boolean;
}

/** 和我共同在群里的注册用户 id */
function peersOf(user: CurrentUser): string[] {
  if (!user.wxId) return [];

  const myGroups = db
    .select({ convId: groupMembers.convId })
    .from(groupMembers)
    .where(and(eq(groupMembers.wxId, user.wxId), isNull(groupMembers.leftAt)))
    .all()
    .map((g) => g.convId);

  if (myGroups.length === 0) return [];

  const peerWxIds = db
    .selectDistinct({ wxId: groupMembers.wxId })
    .from(groupMembers)
    .where(and(inArray(groupMembers.convId, myGroups), isNull(groupMembers.leftAt)))
    .all()
    .map((r) => r.wxId);

  if (peerWxIds.length === 0) return [];

  return db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.wxId, peerWxIds), eq(users.status, "active")))
    .all()
    .map((u) => u.id);
}

/** 每个人和我共同在几个群 */
function sharedGroupCounts(user: CurrentUser, userIds: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  if (!user.wxId || userIds.length === 0) return counts;

  const myGroups = new Set(
    db
      .select({ convId: groupMembers.convId })
      .from(groupMembers)
      .where(and(eq(groupMembers.wxId, user.wxId), isNull(groupMembers.leftAt)))
      .all()
      .map((g) => g.convId),
  );

  const rows = db
    .select({ id: users.id, convId: groupMembers.convId })
    .from(users)
    .innerJoin(groupMembers, eq(groupMembers.wxId, users.wxId))
    .where(and(inArray(users.id, userIds), isNull(groupMembers.leftAt)))
    .all();

  for (const row of rows) {
    if (!myGroups.has(row.convId)) continue;
    counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
  }
  return counts;
}

export interface DirectoryResult {
  members: DirectoryMember[];
  facets: TagFacet[];
  /** 收录了几个人（未按标签筛选前） */
  total: number;
  /** 同群里还有多少注册用户选择了隐身 —— 说出来，别让人以为目录是全的 */
  hidden: number;
  /** 一个标签都没填的人数 —— 目录的价值取决于这个数字往下走 */
  untagged: number;
  /**
   * 模块是不是被关掉了。
   *
   * 必须和「目录是空的」分开：两者在页面上长得一模一样，
   * 而一个显示「还没有人加入」的关停功能，会让用户以为
   * 这个社区没人 —— 这正是这个项目一直在防的那种伪装。
   */
  moduleOff: boolean;
}

export function memberDirectory(
  user: CurrentUser | null,
  options: { tag?: string } = {},
): DirectoryResult {
  const empty: DirectoryResult = {
    members: [],
    facets: [],
    total: 0,
    hidden: 0,
    untagged: 0,
    moduleOff: false,
  };
  if (!user) return empty;
  // 关掉之后目录为空；标签数据本身保留，而且要说清楚是被关了
  if (!isModuleEnabled("directory")) return { ...empty, moduleOff: true };

  const peerIds = peersOf(user);
  if (peerIds.length === 0) return empty;

  const rows = db
    .select({
      id: users.id,
      wxId: users.wxId,
      siteNickname: users.siteNickname,
      wxNickname: users.wxNickname,
      wxAvatarUrl: users.wxAvatarUrl,
      bio: users.bio,
      points: users.points,
      hidden: users.directoryHidden,
    })
    .from(users)
    .where(and(inArray(users.id, peerIds), ne(users.kind, "bot")))
    .all();

  const visible = rows.filter((r) => !r.hidden || r.id === user.id);
  const hidden = rows.length - visible.length;

  // 头像与展示名要走 people 表补齐 —— users 上的可能还没同步到
  const profiles = new Map(
    db
      .select({ wxId: people.wxId, name: people.displayName, avatar: people.avatarUrl })
      .from(people)
      .all()
      .map((p) => [p.wxId, p]),
  );

  const skills = db
    .select()
    .from(userSkills)
    .where(inArray(userSkills.userId, visible.map((r) => r.id)))
    .orderBy(userSkills.sort, userSkills.createdAt)
    .all();

  const byUser = new Map<string, { slug: string; label: string }[]>();
  for (const s of skills) {
    const list = byUser.get(s.userId) ?? [];
    list.push({ slug: s.slug, label: s.label });
    byUser.set(s.userId, list);
  }

  const shared = sharedGroupCounts(user, visible.map((r) => r.id));
  // 批量取称号 —— 逐个查会在成员数上打出 N+1
  const titles = equippedTitles(visible.map((r) => r.id));

  let members: DirectoryMember[] = visible.map((row) => {
    const profile = row.wxId ? profiles.get(row.wxId) : undefined;
    const title = titles.get(row.id) ?? null;
    return {
      id: row.id,
      name: resolveDisplayName([row.siteNickname, row.wxNickname, profile?.name], {
        wxId: row.wxId,
        fallback: "成员",
      }),
      avatarUrl: profile?.avatar ?? row.wxAvatarUrl ?? null,
      paletteIndex: paletteIndexFor(row.wxId ?? row.id),
      bio: row.bio,
      title,
      tags: byUser.get(row.id) ?? [],
      sharedGroups: shared.get(row.id) ?? 0,
      points: row.points,
      isMe: row.id === user.id,
    };
  });

  const facets = buildFacets(members);
  const untagged = members.filter((m) => m.tags.length === 0).length;
  const total = members.length;

  if (options.tag) {
    members = members.filter((m) => m.tags.some((t) => t.slug === options.tag));
  }

  /*
   * 排序：填了标签的排前面。
   *
   * 这不是偏心，是这一页的用途决定的 —— 目录是用来「找到会某件事的人」的，
   * 而没有标签的行对这个用途一点帮助都没有。把它们排在前面，
   * 第一屏就会全是无法据以联系的人，然后没人再往下翻。
   */
  members.sort(
    (a, b) =>
      Number(b.tags.length > 0) - Number(a.tags.length > 0) ||
      b.points - a.points ||
      a.name.localeCompare(b.name, "zh"),
  );

  return { members, facets, total, hidden, untagged, moduleOff: false };
}

function buildFacets(members: DirectoryMember[]): TagFacet[] {
  const bySlug = new Map<string, Map<string, number>>();
  for (const member of members) {
    for (const tag of member.tags) {
      const labels = bySlug.get(tag.slug) ?? new Map<string, number>();
      labels.set(tag.label, (labels.get(tag.label) ?? 0) + 1);
      bySlug.set(tag.slug, labels);
    }
  }

  const facets: TagFacet[] = [];
  for (const [slug, labels] of bySlug) {
    const entries = [...labels].map(([label, count]) => ({ label, count }));
    facets.push({
      slug,
      label: preferredLabel(entries),
      count: entries.reduce((n, e) => n + e.count, 0),
    });
  }
  return visibleFacets(facets);
}

/** 我自己的标签，供设置页回填 */
export function mySkills(userId: string): { slug: string; label: string }[] {
  return db
    .select({ slug: userSkills.slug, label: userSkills.label })
    .from(userSkills)
    .where(eq(userSkills.userId, userId))
    .orderBy(userSkills.sort, userSkills.createdAt)
    .all();
}

export function isDirectoryHidden(userId: string): boolean {
  return (
    db.select({ hidden: users.directoryHidden }).from(users).where(eq(users.id, userId)).get()
      ?.hidden ?? false
  );
}

/**
 * 全站标签热度 —— 只给后台看。
 *
 * 前台的 facets 是「和你同群的人里」的分布，后台这个是全站的。
 * 两者不同是**对的**：前台泄露全站分布等于泄露了别的群有什么人。
 */
export function allTagFacets(): TagFacet[] {
  const rows = db.select().from(userSkills).all();
  const bySlug = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const labels = bySlug.get(row.slug) ?? new Map<string, number>();
    labels.set(row.label, (labels.get(row.label) ?? 0) + 1);
    bySlug.set(row.slug, labels);
  }
  return [...bySlug].map(([slug, labels]) => {
    const entries = [...labels].map(([label, count]) => ({ label, count }));
    return {
      slug,
      label: preferredLabel(entries),
      count: entries.reduce((n, e) => n + e.count, 0),
    };
  }).sort((a, b) => b.count - a.count);
}

/** 目录里贡献最高的几个人，首页用 */
export function directoryHighlights(user: CurrentUser | null, limit = 6): DirectoryMember[] {
  return memberDirectory(user)
    .members.filter((m) => m.tags.length > 0)
    .sort((a, b) => b.points - a.points)
    .slice(0, limit);
}
