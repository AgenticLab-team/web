import "server-only";

import { and, eq, inArray, isNull, ne } from "drizzle-orm";

import type { CurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { groupMembers, people, userSkills, users } from "@/lib/db/schema";
import { paletteIndexFor } from "@/components/Avatar";
import { isModuleEnabled } from "@/lib/modules/state";
import { leaderboardHiddenWxIds } from "@/lib/privacy/queries";
import { matchesQuery, preferredLabel, visibleFacets, type TagFacet } from "@/lib/members/tags";
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
  /**
   * 有没有站内主页可以点进去。
   *
   * **这里仍然不给 wx_id** —— 它会被序列化进 RSC 载荷、出现在网页源码里。
   * 目录列的是所有同群的人，包括从没在群里说过话的：他们的 wx_id
   * 在别处拿不到（存档里只有开过口的人），而拿着 wx_id 就能在微信里
   * 直接加人。一次「让头像可以点」不该顺带把一群沉默的人的微信号
   * 摊在页面源码里。
   *
   * 所以只给一个布尔，链接走 `/members/by/<账号 id>` 那条中转 ——
   * 账号 id 本来就在这个结构里（列表的 key 用它）。
   */
  hasProfile: boolean;
  bio: string | null;
  title: { name: string; icon: string | null; rarity: string } | null;
  tags: { slug: string; label: string }[];
  /** 和你共同在几个群 —— 只说数量，不说是哪个 */
  sharedGroups: number;
  /**
   * 积分。**关掉了「出现在榜单上」的人这里是 null。**
   *
   * 那个开关承诺的是「别人看到的榜单里没有你」。而一份显示积分、
   * 又按积分排序的成员目录**就是另一张榜** —— 只是换了个名字。
   * 一个只在其中一处生效的隐私开关，比没有开关更坏：
   * 它让人以为自己藏起来了。
   *
   * 注意这跟 `directory_hidden` 是两件事，两个开关各管各的：
   * 隐身管的是「出不出现在目录里」，这个管的是「露不露贡献数字」。
   */
  points: number | null;
  /**
   * 最近在群里说过话没有 —— 只给一个粗粒度的档，不给时间点。
   *
   * 「谁最近活跃」是这一页要回答的问题之一：一份分不出
   * 「还在」和「半年没来过」的名单，找人的时候等于没有。
   *
   * 但只到「这周 / 这个月」为止。lib/privacy/rules.ts 里删掉
   * `hide_activity_hours` 时写明了理由：那个开关守的是**作息**
   * （几点睡、几点起），而作息是逐小时的直方图才暴露得出来的东西。
   * 粗到「本周活跃过」这一档，说的是「这个人还在」，不是他的生活规律。
   *
   * 和积分一样跟着榜单开关走：关掉的人这里是 null。
   */
  activity: "week" | "month" | null;
  isMe: boolean;
}

/** 「最近活跃」的分档 */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

function activityBucket(lastSeen: number | null | undefined, now: number): "week" | "month" | null {
  if (!lastSeen) return null;
  const age = now - lastSeen;
  if (age <= WEEK_MS) return "week";
  if (age <= MONTH_MS) return "month";
  return null;
}

/**
 * 目录的排序方式。
 *
 * 三种排法对应这一页真正要回答的三个问题：
 *   · tags   —— 「谁会做 X」：填了标签的排前面，没标签的行对找人毫无帮助
 *   · shared —— 「谁和我在同一个群」：共同群多的人，搭话的成本最低
 *   · active —— 「谁最近还在」：一份分不出活人的名单，找人时等于没有
 */
export const MEMBER_SORTS = ["tags", "shared", "active"] as const;
export type MemberSort = (typeof MEMBER_SORTS)[number];

export function resolveSort(value: string | undefined): MemberSort {
  return (MEMBER_SORTS as readonly string[]).includes(value ?? "")
    ? (value as MemberSort)
    : "tags";
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
  /** 按当前条件筛出来还剩几个 —— 搜不到东西时要说得出是「搜的」还是「本来就没有」 */
  matched: number;
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
  options: { tag?: string; q?: string; sort?: MemberSort; now?: number } = {},
): DirectoryResult {
  const empty: DirectoryResult = {
    members: [],
    facets: [],
    total: 0,
    hidden: 0,
    untagged: 0,
    matched: 0,
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

  // 头像与展示名要走 people 表补齐 —— users 上的可能还没同步到。
  // lastSeen 顺路一起取：单独再查一次是白给的一次全表扫描
  const profiles = new Map(
    db
      .select({
        wxId: people.wxId,
        name: people.displayName,
        avatar: people.avatarUrl,
        lastSeen: people.lastSeen,
      })
      .from(people)
      .all()
      .map((p) => [p.wxId, p]),
  );

  /*
   * 关掉了「出现在榜单上」的人，在目录里不露贡献数字。
   *
   * 这是一个**新加的展示要过一遍旧开关**的例子：目录本来就显示积分、
   * 还按积分排序，等于一张没人叫它榜单的榜；现在又要加「最近活跃」。
   * 每加一个能按人找到内容的入口，就得回来问一遍
   * 「这个人关掉了开关的话，这里会不会漏」—— 这次的答案是会。
   */
  const noMetrics = new Set(leaderboardHiddenWxIds(user));
  const now = options.now ?? Date.now();

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
    const metricsOk = !row.wxId || !noMetrics.has(row.wxId);
    return {
      id: row.id,
      name: resolveDisplayName([row.siteNickname, row.wxNickname, profile?.name], {
        wxId: row.wxId,
        fallback: "成员",
      }),
      avatarUrl: profile?.avatar ?? row.wxAvatarUrl ?? null,
      paletteIndex: paletteIndexFor(row.wxId ?? row.id),
      // 只说「有没有主页」，不给 wx_id —— 链接走 /members/by/<账号 id>
      hasProfile: Boolean(row.wxId),
      bio: row.bio,
      title,
      tags: byUser.get(row.id) ?? [],
      sharedGroups: shared.get(row.id) ?? 0,
      points: metricsOk ? row.points : null,
      activity: metricsOk ? activityBucket(profile?.lastSeen, now) : null,
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
   * 搜索用的是和标签筛选同一套归一化（见 lib/members/tags.ts 的 matchesQuery）——
   * 搜「RAG」和点标签「rag」找到的是同一批人，否则同一页里两个入口各有各的脾气。
   */
  if (options.q?.trim()) {
    members = members.filter((m) => matchesQuery(m, options.q!));
  }

  sortMembers(members, options.sort ?? "tags");

  return { members, facets, total, hidden, untagged, matched: members.length, moduleOff: false };
}

/**
 * 排序。三种排法，末位一律用姓名兜底 ——
 * 不兜的话，同分的人每次刷新顺序都不一样，看起来像列表在自己动。
 */
function sortMembers(members: DirectoryMember[], sort: MemberSort): void {
  const byName = (a: DirectoryMember, b: DirectoryMember) => a.name.localeCompare(b.name, "zh");
  const rank = { week: 2, month: 1 } as const;
  const activityRank = (m: DirectoryMember) => (m.activity ? rank[m.activity] : 0);

  if (sort === "shared") {
    members.sort((a, b) => b.sharedGroups - a.sharedGroups || byName(a, b));
    return;
  }

  if (sort === "active") {
    members.sort((a, b) => activityRank(b) - activityRank(a) || byName(a, b));
    return;
  }

  /*
   * 默认：填了标签的排前面。
   *
   * 这不是偏心，是这一页的用途决定的 —— 目录是用来「找到会某件事的人」的，
   * 而没有标签的行对这个用途一点帮助都没有。把它们排在前面，
   * 第一屏就会全是无法据以联系的人，然后没人再往下翻。
   *
   * 次级键用积分，而藏起了积分的人按 0 算 —— 他排得靠后一点，
   * 但**不会因为藏了积分就从目录里消失**：隐身是另一个开关的事。
   */
  members.sort(
    (a, b) =>
      Number(b.tags.length > 0) - Number(a.tags.length > 0) ||
      (b.points ?? 0) - (a.points ?? 0) ||
      byName(a, b),
  );
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

/*
 * 这里原来还有一个 `directoryHighlights`：注释写着「首页用」，
 * 而全站**零处调用** —— 首页从来没有过这一块。
 *
 * 删掉不只是因为它没人用。它做的事是「按积分排序取前 6 个人」，
 * 也就是一张**没叫自己榜单的榜单**，而且没过 leaderboardHiddenWxIds。
 * 哪天有人把它接到首页上，关掉了「出现在榜单上」的人就会出现在
 * 首页最显眼的位置，而改动看起来只是「加了个模块」。
 *
 * 真要做首页高亮，走 lib/queries/leaderboard.ts —— 隐私收口在那边。
 */
