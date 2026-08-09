import "server-only";

import { and, desc, eq, gte, isNull, lt } from "drizzle-orm";

import { contentHash } from "@/lib/broadcast/rules";
import { db } from "@/lib/db";
import { broadcasts, digestRuns, posts, users } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { getSettingBool, getSettingInt } from "@/lib/settings/store";
import {
  MAX_ITEMS,
  MAX_PER_AUTHOR,
  renderDigest,
  selectDigest,
  shouldPublish,
  weekLabel,
  weekStartOf,
  type DigestCandidate,
} from "@/lib/digest/weekly";
import { resolveDisplayName } from "@/lib/users/display-name";
import { dateKey } from "@/lib/time";

/**
 * 每周精选的生成。
 *
 * ─────────────────────────────────────────
 * 它只生成草稿，永远不发送
 * ─────────────────────────────────────────
 *
 * 一个每周自动向一千六百人广播的机器人，被风控只是时间问题；
 * 而且没有人会为一条没人看过的自动消息负责。
 *
 * 所以这里做到「草稿备好、内容哈希算好」为止，
 * 剩下的复核与发送走群发那一整套已有的流程 ——
 * 双人复核、发送间隔、每日上限、两分钟撤回窗口，一样都不少。
 *
 * 顺带一提这也满足那条硬规矩：**站点不代任何用户发消息**。
 * 精选是系统公告，署名是站点，不是任何一个人。
 */

const SYSTEM_ACTOR = "system:weekly-digest";

export interface BuildResult {
  weekStart: string;
  ok: boolean;
  reason: string;
  broadcastId?: string;
  itemCount: number;
  /** 被挡下来的候选与原因 —— 空手而归时要说得出为什么 */
  rejected: { id: string; reason: string }[];
}

/** 上一周（相对于给定时间）的周一 */
export function previousWeekStart(now: number): string {
  const thisWeek = weekStartOf(dateKey(now));
  const [y, m, d] = thisWeek.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() - 7);
  return date.toISOString().slice(0, 10);
}

function weekRange(weekStart: string): { from: number; to: number } {
  const [y, m, d] = weekStart.split("-").map(Number);
  // 东八区的周一零点 = UTC 前一天 16:00
  const from = Date.UTC(y, m - 1, d) - 8 * 3600_000;
  return { from, to: from + 7 * 86_400_000 };
}

/**
 * 往期精选推过的帖子 —— 不重复推同一篇。
 *
 * **要排除正在重算的这一周自己。** 不排除的话 `--force` 是废的：
 * 唯一会用到 force 的场景就是「这一周重新生成一遍」，
 * 而那一周自己选中的帖子会把候选清空，重算永远得到一个空精选。
 */
function alreadySent(exceptWeek?: string): Set<string> {
  const rows = db
    .select({ weekStart: digestRuns.weekStart, postIds: digestRuns.postIds })
    .from(digestRuns)
    .all();

  const seen = new Set<string>();
  for (const row of rows) {
    if (exceptWeek && row.weekStart === exceptWeek) continue;
    for (const id of (row.postIds as string[] | null) ?? []) seen.add(id);
  }
  return seen;
}

function candidatesOf(weekStart: string): DigestCandidate[] {
  const { from, to } = weekRange(weekStart);

  const rows = db
    .select({
      id: posts.id,
      title: posts.title,
      excerpt: posts.excerpt,
      visibility: posts.visibility,
      status: posts.status,
      featured: posts.featured,
      replyCount: posts.replyCount,
      reactionCount: posts.reactionCount,
      viewCount: posts.viewCount,
      createdAt: posts.createdAt,
      anonymous: posts.anonymous,
      authorId: posts.authorId,
      siteNickname: users.siteNickname,
      wxNickname: users.wxNickname,
    })
    .from(posts)
    .leftJoin(users, eq(users.id, posts.authorId))
    .where(
      and(
        gte(posts.createdAt, from),
        lt(posts.createdAt, to),
        isNull(posts.deletedAt),
      ),
    )
    .orderBy(desc(posts.createdAt))
    .all();

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    excerpt: row.excerpt,
    // 匿名帖不署名 —— 精选不该成为反匿名的路
    authorName: row.anonymous
      ? "匿名"
      : resolveDisplayName([row.siteNickname, row.wxNickname], { fallback: "成员" }),
    visibility: row.visibility,
    status: row.status,
    featured: row.featured,
    replyCount: row.replyCount,
    reactionCount: row.reactionCount,
    viewCount: row.viewCount,
    createdAt: row.createdAt,
    authorId: row.authorId,
    // 转帖来的帖子可见性本身就被锁住了，这里只做标记
    fromGroupChat: row.visibility === "group",
  }));
}

/**
 * 生成某一周的精选草稿。
 *
 * 同一周只生成一次 —— 重复生成会攒出一堆内容几乎一样的草稿，
 * 而复核的人看到五条一样的东西，第一反应是全部忽略。
 */
export function buildWeeklyDigest(
  options: { weekStart?: string; now?: number; force?: boolean } = {},
): BuildResult {
  const now = options.now ?? Date.now();
  const weekStart = options.weekStart ?? previousWeekStart(now);

  const existing = db
    .select()
    .from(digestRuns)
    .where(eq(digestRuns.weekStart, weekStart))
    .get();

  if (existing && !options.force) {
    return {
      weekStart,
      ok: false,
      reason: existing.broadcastId
        ? `这一周已经生成过草稿了（${existing.broadcastId}）`
        : `这一周已经判定为不发：${existing.skipReason}`,
      broadcastId: existing.broadcastId ?? undefined,
      itemCount: existing.itemCount,
      rejected: [],
    };
  }

  /*
   * ─────────────────────────────────────────
   * 这三个配置项在后台摆着，而一直没有任何地方读
   * ─────────────────────────────────────────
   *
   * 「启用每周精选回推」关掉 —— 定时任务照样每周生成草稿。
   * 「每期推送帖子数」改成 3 —— 照样出 5 条。
   * 一个拨了没反应的旋钮比没有旋钮坏：它不是少了个功能，
   * 是给了一个错误的答案，而管理员不会再去验证。
   */
  if (!getSettingBool("digest.enabled", false)) {
    return {
      weekStart,
      ok: false,
      // 说清楚是「被关掉了」，不是「这周没内容」—— 两者的下一步完全不同
      reason: "每周精选回推没有启用（后台「启用每周精选回推」）",
      itemCount: 0,
      rejected: [],
    };
  }

  const selection = selectDigest(candidatesOf(weekStart), {
    alreadySent: alreadySent(weekStart),
    max: getSettingInt("digest.top_n", MAX_ITEMS),
    maxPerAuthor: getSettingInt("digest.max_per_author", MAX_PER_AUTHOR),
  });
  const verdict = shouldPublish(selection);

  if (!verdict.ok) {
    // 判定为不发也要留一行 —— 「这周怎么没有精选」要答得上来
    db.insert(digestRuns)
      .values({
        weekStart,
        postIds: [],
        itemCount: selection.items.length,
        skipReason: verdict.reason,
      })
      .onConflictDoUpdate({
        target: digestRuns.weekStart,
        set: { skipReason: verdict.reason, itemCount: selection.items.length, postIds: [] },
      })
      .run();

    return {
      weekStart,
      ok: false,
      reason: verdict.reason,
      itemCount: selection.items.length,
      rejected: selection.rejected,
    };
  }

  const content = renderDigest(selection.items, {
    siteUrl: env.site.url,
    weekLabel: weekLabel(weekStart),
  });

  const broadcast = db
    .insert(broadcasts)
    .values({
      channel: "wechat",
      title: `${weekLabel(weekStart)} 社区精选`,
      content,
      // 提前算好哈希：复核之后再改内容，发送会被拒
      contentHash: contentHash(content),
      // 留空 = 所有已接入的群。内容只含所有成员都能看的帖子，所以一份就够
      targetConvIds: null,
      status: "draft",
      createdBy: SYSTEM_ACTOR,
    })
    .returning({ id: broadcasts.id })
    .get();

  db.insert(digestRuns)
    .values({
      weekStart,
      postIds: selection.items.map((i) => i.id),
      itemCount: selection.items.length,
      broadcastId: broadcast.id,
    })
    .onConflictDoUpdate({
      target: digestRuns.weekStart,
      set: {
        postIds: selection.items.map((i) => i.id),
        itemCount: selection.items.length,
        broadcastId: broadcast.id,
        skipReason: null,
      },
    })
    .run();

  return {
    weekStart,
    ok: true,
    reason: `${verdict.reason} —— 草稿已备好，等人复核后发送`,
    broadcastId: broadcast.id,
    itemCount: selection.items.length,
    rejected: selection.rejected,
  };
}

/** 最近几期的生成记录，后台用 */
export function recentDigests(limit = 8) {
  return db.select().from(digestRuns).orderBy(desc(digestRuns.weekStart)).limit(limit).all();
}

export { SYSTEM_ACTOR };
