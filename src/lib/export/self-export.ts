import "server-only";

import { and, asc, desc, eq, gt, gte, inArray, lt, lte, or, sql } from "drizzle-orm";

import { csvTime } from "@/lib/activities/export-rules";
import type { CurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import {
  boards,
  bookmarks,
  dataExports,
  drafts,
  messages,
  pollVotes,
  postTags,
  posts,
  reactions,
  replies,
  tags,
  users,
} from "@/lib/db/schema";
import { buildViewerContext } from "@/lib/forum/context";
import { canSeePost } from "@/lib/forum/visibility";
import { visibleGroupsFor } from "@/lib/queries/visibility";

import {
  EXPORT_DAY_MS,
  FILES,
  MAX_OWN_MESSAGES,
  buildManifest,
  buildReadme,
  createPseudonyms,
  emptyCounts,
  exportRateVerdict,
  type ExportCounts,
  type RateVerdict,
} from "./self-export-rules";
import {
  draftLines,
  interactionLines,
  messageLines,
  postLines,
  replyLines,
  type Cursor,
  type ExportSource,
  type ForumInteractionRow,
  type PostContext,
  type RawMessage,
  type StreamOptions,
} from "./self-export-stream";
import { zipStream, type ZipEntry } from "./zip";

/**
 * 「导出我自己的数据」的服务端部分。
 *
 * 规则在 self-export-rules.ts（纯的、有测试），组装在
 * self-export-stream.ts（依赖注入、有测试）。这里只负责
 * **把真实的数据库接上去**，以及限流与留痕。
 *
 * 这个文件里每一条 SQL 都带 limit 或者只返回一行。
 * 一条 `.all()` 全量查询就足以让一个发过四万条消息的人
 * 把那台 3.7G 的机器打死 —— 这不是理论上的风险，
 * 那台机器今天已经不稳了。
 */

/* ───────────────────────────────────────────────────────────────
 * (ts, id) 复合游标
 * ─────────────────────────────────────────────────────────────── */

/**
 * 时间戳会撞 —— 同一秒里的两条消息 ts 完全相同，
 * 只按 ts 翻页会让其中一条重复出现、另一条永远翻不到。
 * 所以每个游标条件都得把 id 作为第二排序键带上。
 */
const afterCursor = (c: Cursor) =>
  or(gt(messages.ts, c.ts), and(eq(messages.ts, c.ts), gt(messages.id, c.id)));

const beforeCursor = (c: Cursor) =>
  or(lt(messages.ts, c.ts), and(eq(messages.ts, c.ts), lt(messages.id, c.id)));

const atOrAfterCursor = (c: Cursor) =>
  or(gt(messages.ts, c.ts), and(eq(messages.ts, c.ts), gte(messages.id, c.id)));

const atOrBeforeCursor = (c: Cursor) =>
  or(lt(messages.ts, c.ts), and(eq(messages.ts, c.ts), lte(messages.id, c.id)));

const MESSAGE_COLUMNS = {
  id: messages.id,
  convId: messages.convId,
  senderWxId: messages.senderWxId,
  isSend: messages.isSend,
  type: messages.type,
  content: messages.content,
  ts: messages.ts,
  isQuality: messages.isQuality,
  hasMedia: messages.hasMedia,
} as const;

/* ───────────────────────────────────────────────────────────────
 * 数据源
 * ─────────────────────────────────────────────────────────────── */

/**
 * 把一个登录用户接到取数接口上。
 *
 * **主体只能是传进来的这个 user。** 这个函数不接受任何
 * 「导出谁」的参数，也没有任何一条 SQL 的过滤条件来自请求 ——
 * 想导别人的数据，得先改这个函数的签名。
 */
export function createExportSource(user: CurrentUser): ExportSource {
  const selfWxId = user.wxId;

  /*
   * 可见群一次查完。**这就是上下文的边界** ——
   * 他此刻仍在、且已接入本站的群。退了的群不在里面，
   * 于是那些群自动只剩「自己说过的话」，没有上下文、没有群名。
   */
  const visible = new Map(visibleGroupsFor(user).map((g) => [g.convId, g.name]));
  const viewer = buildViewerContext(user);

  const messagePage = (
    where: ReturnType<typeof and>,
    order: "asc" | "desc",
    limit: number,
  ): RawMessage[] =>
    db
      .select(MESSAGE_COLUMNS)
      .from(messages)
      .where(where)
      .orderBy(
        order === "asc" ? asc(messages.ts) : desc(messages.ts),
        order === "asc" ? asc(messages.id) : desc(messages.id),
      )
      .limit(limit)
      .all();

  return {
    ownMessageCount() {
      if (!selfWxId) return 0;
      const row = db
        .select({ n: sql<number>`count(*)` })
        .from(messages)
        .where(eq(messages.senderWxId, selfWxId))
        .get();
      return row?.n ?? 0;
    },

    ownMessageCutoff(skipFromNewest) {
      if (!selfWxId) return null;
      /*
       * 从新往旧数第 (skip+1) 条。它就是「保留最新 skip 条」的起始游标 ——
       * 严格大于它的正好是最新的那 skip 条。
       */
      const row = db
        .select({ ts: messages.ts, id: messages.id })
        .from(messages)
        .where(eq(messages.senderWxId, selfWxId))
        .orderBy(desc(messages.ts), desc(messages.id))
        .limit(1)
        .offset(skipFromNewest)
        .get();
      return row ?? null;
    },

    ownMessagePage(after, limit) {
      if (!selfWxId) return [];
      return messagePage(
        and(eq(messages.senderWxId, selfWxId), after ? afterCursor(after) : undefined),
        "asc",
        limit,
      );
    },

    contextBefore(convId, before, minTs, limit) {
      if (!visible.has(convId)) return [];
      return messagePage(
        and(eq(messages.convId, convId), gte(messages.ts, minTs), beforeCursor(before)),
        "desc",
        limit,
      );
    },

    windowBody(convId, from, to, limit) {
      if (!visible.has(convId)) return [];
      return messagePage(
        and(eq(messages.convId, convId), atOrAfterCursor(from), atOrBeforeCursor(to)),
        "asc",
        limit,
      );
    },

    contextAfter(convId, after, maxTs, limit) {
      if (!visible.has(convId)) return [];
      return messagePage(
        and(eq(messages.convId, convId), lte(messages.ts, maxTs), afterCursor(after)),
        "asc",
        limit,
      );
    },

    isVisibleGroup: (convId) => visible.has(convId),
    groupName: (convId) => visible.get(convId) ?? null,

    postsPage(afterId, limit) {
      const rows = db
        .select({
          id: posts.id,
          boardKey: boards.key,
          boardName: boards.name,
          title: posts.title,
          content: posts.content,
          type: posts.type,
          status: posts.status,
          visibility: posts.visibility,
          anonymous: posts.anonymous,
          pinned: posts.pinned,
          replyCount: posts.replyCount,
          reactionCount: posts.reactionCount,
          viewCount: posts.viewCount,
          createdAt: posts.createdAt,
          updatedAt: posts.updatedAt,
          deletedAt: posts.deletedAt,
        })
        .from(posts)
        .leftJoin(boards, eq(boards.id, posts.boardId))
        .where(and(eq(posts.authorId, user.id), afterId ? gt(posts.id, afterId) : undefined))
        .orderBy(asc(posts.id))
        .limit(limit)
        .all();

      if (rows.length === 0) return [];

      // 标签一次查这一页的，别一帖一查
      const tagRows = db
        .select({ postId: postTags.postId, name: tags.name })
        .from(postTags)
        .innerJoin(tags, eq(tags.id, postTags.tagId))
        .where(
          inArray(
            postTags.postId,
            rows.map((r) => r.id),
          ),
        )
        .all();

      const byPost = new Map<string, string[]>();
      for (const t of tagRows) {
        const list = byPost.get(t.postId) ?? [];
        list.push(t.name);
        byPost.set(t.postId, list);
      }

      return rows.map((r) => ({ ...r, tags: byPost.get(r.id) ?? [] }));
    },

    repliesPage(afterId, limit) {
      return db
        .select({
          id: replies.id,
          postId: replies.postId,
          parentId: replies.parentId,
          floor: replies.floor,
          content: replies.content,
          status: replies.status,
          accepted: replies.accepted,
          anonymous: replies.anonymous,
          reactionCount: replies.reactionCount,
          createdAt: replies.createdAt,
          deletedAt: replies.deletedAt,
        })
        .from(replies)
        .where(and(eq(replies.authorId, user.id), afterId ? gt(replies.id, afterId) : undefined))
        .orderBy(asc(replies.id))
        .limit(limit)
        .all();
    },

    draftsPage(afterId, limit) {
      return db
        .select({
          id: drafts.id,
          targetType: drafts.targetType,
          targetId: drafts.targetId,
          boardId: drafts.boardId,
          title: drafts.title,
          content: drafts.content,
          updatedAt: drafts.updatedAt,
        })
        .from(drafts)
        .where(and(eq(drafts.userId, user.id), afterId ? gt(drafts.id, afterId) : undefined))
        .orderBy(asc(drafts.id))
        .limit(limit)
        .all();
    },

    bookmarksPage(afterId, limit): ForumInteractionRow[] {
      return db
        .select({
          id: bookmarks.id,
          targetId: bookmarks.postId,
          detail: bookmarks.note,
          createdAt: bookmarks.createdAt,
        })
        .from(bookmarks)
        .where(and(eq(bookmarks.userId, user.id), afterId ? gt(bookmarks.id, afterId) : undefined))
        .orderBy(asc(bookmarks.id))
        .limit(limit)
        .all()
        .map((r) => ({ ...r, kind: "bookmark" as const, targetType: "post" }));
    },

    reactionsPage(afterId, limit): ForumInteractionRow[] {
      return db
        .select({
          id: reactions.id,
          targetType: reactions.targetType,
          targetId: reactions.targetId,
          detail: reactions.kind,
          createdAt: reactions.createdAt,
        })
        .from(reactions)
        .where(and(eq(reactions.userId, user.id), afterId ? gt(reactions.id, afterId) : undefined))
        .orderBy(asc(reactions.id))
        .limit(limit)
        .all()
        .map((r) => ({ ...r, kind: "reaction" as const }));
    },

    pollVotesPage(afterId, limit): ForumInteractionRow[] {
      return db
        .select({
          id: pollVotes.id,
          targetId: pollVotes.pollId,
          detail: pollVotes.optionId,
          createdAt: pollVotes.createdAt,
        })
        .from(pollVotes)
        .where(and(eq(pollVotes.userId, user.id), afterId ? gt(pollVotes.id, afterId) : undefined))
        .orderBy(asc(pollVotes.id))
        .limit(limit)
        .all()
        .map((r) => ({ ...r, kind: "poll_vote" as const, targetType: "poll" }));
    },

    postContext(postId): PostContext {
      const row = db
        .select({
          title: posts.title,
          excerpt: posts.excerpt,
          content: posts.content,
          authorId: posts.authorId,
          authorWxId: users.wxId,
          status: posts.status,
          visibility: posts.visibility,
          visibilityRoleId: posts.visibilityRoleId,
          visibilityGroupId: posts.visibilityGroupId,
          visibilityLocked: posts.visibilityLocked,
        })
        .from(posts)
        .leftJoin(users, eq(users.id, posts.authorId))
        .where(eq(posts.id, postId))
        .get();

      const missing: PostContext = {
        visible: false,
        reason: "原帖已不存在",
        title: null,
        excerpt: null,
        authorKey: null,
        authorIsSelf: false,
      };
      if (!row) return missing;

      /*
       * 可见性判定复用论坛那一套，**不另写一份**。
       * 另写一份的必然结局是两份规则慢慢分叉，而分叉的那一天
       * 只会在导出这边被发现 —— 也就是数据已经落到本地之后。
       *
       * fromGroupChat 用 visibilityLocked 代替：群聊转帖在写入时
       * 一定被 normalizePostVisibility 压成 group 级并锁定，
       * 所以这个代理只会更严，不会更松。
       */
      const verdict = canSeePost(
        {
          visibility: row.visibility,
          visibilityRoleId: row.visibilityRoleId,
          visibilityGroupId: row.visibilityGroupId,
          authorId: row.authorId,
          status: row.status,
          fromGroupChat: row.visibilityLocked,
        },
        viewer,
      );

      const authorIsSelf = row.authorId === user.id;
      return {
        visible: verdict.visible,
        reason: verdict.visible ? null : verdict.reason,
        title: verdict.visible ? row.title : null,
        excerpt: verdict.visible ? (row.excerpt ?? row.content.slice(0, 200)) : null,
        // 没绑微信的作者用站内 id 兜底，前缀区分开，免得和 wx_id 撞
        authorKey: row.authorWxId ?? `u:${row.authorId}`,
        authorIsSelf,
      };
    },
  };
}

/* ───────────────────────────────────────────────────────────────
 * 限流与留痕
 * ─────────────────────────────────────────────────────────────── */

/** 这个人最近一天发起过的导出时间。判定本身是纯的，在 rules 里 */
export function recentExportStarts(userId: string, now: number): number[] {
  return db
    .select({ startedAt: dataExports.startedAt })
    .from(dataExports)
    .where(and(eq(dataExports.userId, userId), gte(dataExports.startedAt, now - EXPORT_DAY_MS)))
    .all()
    .map((r) => r.startedAt);
}

export function checkExportRate(userId: string, now: number = Date.now()): RateVerdict {
  return exportRateVerdict(recentExportStarts(userId, now), now);
}

export interface ExportContext {
  ip?: string;
  userAgent?: string;
  withContext: boolean;
}

/** 开始之前先记一行。**限流数的就是这些行** */
export function beginExport(userId: string, ctx: ExportContext): string {
  const row = db
    .insert(dataExports)
    .values({
      userId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      withContext: ctx.withContext,
      status: "started",
    })
    .returning({ id: dataExports.id })
    .get();
  return row.id;
}

export function finishExport(id: string, counts: ExportCounts, bytes: number): void {
  db.update(dataExports)
    .set({
      status: "completed",
      ownMessages: counts.ownMessages,
      contextMessages: counts.contextMessages,
      windows: counts.windows,
      posts: counts.posts,
      replies: counts.replies,
      drafts: counts.drafts,
      interactions: counts.interactions,
      truncated: counts.truncated,
      bytes,
      finishedAt: Date.now(),
    })
    .where(eq(dataExports.id, id))
    .run();
}

export function failExport(id: string, error: string): void {
  db.update(dataExports)
    .set({ status: "failed", error: error.slice(0, 500), finishedAt: Date.now() })
    .where(eq(dataExports.id, id))
    .run();
}

/** 个人中心里显示的最近几次导出。只查自己的 */
export interface ExportRecord {
  id: string;
  status: string;
  withContext: boolean;
  ownMessages: number;
  contextMessages: number;
  posts: number;
  replies: number;
  truncated: boolean;
  bytes: number;
  startedAt: number;
}

export function myRecentExports(userId: string, limit = 5): ExportRecord[] {
  return db
    .select({
      id: dataExports.id,
      status: dataExports.status,
      withContext: dataExports.withContext,
      ownMessages: dataExports.ownMessages,
      contextMessages: dataExports.contextMessages,
      posts: dataExports.posts,
      replies: dataExports.replies,
      truncated: dataExports.truncated,
      bytes: dataExports.bytes,
      startedAt: dataExports.startedAt,
    })
    .from(dataExports)
    .where(eq(dataExports.userId, userId))
    .orderBy(desc(dataExports.startedAt))
    .limit(limit)
    .all();
}

/** 导出前给用户看的概览：他大概会拿到多少东西 */
export interface ExportPreview {
  ownMessages: number;
  visibleGroups: number;
  posts: number;
  replies: number;
  willTruncate: boolean;
}

export function exportPreview(user: CurrentUser): ExportPreview {
  const countOf = (table: typeof posts | typeof replies) =>
    db
      .select({ n: sql<number>`count(*)` })
      .from(table)
      .where(eq(table.authorId, user.id))
      .get()?.n ?? 0;

  const ownMessages = user.wxId
    ? (db
        .select({ n: sql<number>`count(*)` })
        .from(messages)
        .where(eq(messages.senderWxId, user.wxId))
        .get()?.n ?? 0)
    : 0;

  return {
    ownMessages,
    visibleGroups: visibleGroupsFor(user).length,
    posts: countOf(posts),
    replies: countOf(replies),
    willTruncate: ownMessages > MAX_OWN_MESSAGES,
  };
}

/* ───────────────────────────────────────────────────────────────
 * 组装
 * ─────────────────────────────────────────────────────────────── */

/** 自己的账号信息。密码哈希、会话令牌、管理员备注都不在这里 */
function profileOf(user: CurrentUser, groupCount: number): string {
  return `${JSON.stringify(
    {
      id: user.id,
      wxId: user.wxId,
      username: user.username,
      siteNickname: user.siteNickname,
      wxNickname: user.wxNickname,
      bio: user.bio,
      email: user.email,
      phone: user.phone,
      kind: user.kind,
      status: user.status,
      level: user.level,
      points: user.points,
      pointsTotal: user.pointsTotal,
      streakCurrent: user.streakCurrent,
      streakBest: user.streakBest,
      lastCheckinDate: user.lastCheckinDate,
      firstBoundAt: user.firstBoundAt,
      lastActiveAt: user.lastActiveAt,
      createdAt: user.createdAt,
      // 「我在几个群」给数字，不给群名 —— 群列表本身是隐私，
      // 各群的名字已经在 messages.jsonl 里按可见性给过了
      visibleGroupCount: groupCount,
    },
    null,
    2,
  )}\n`;
}

async function* once(text: string): AsyncGenerator<string> {
  yield text;
}

export interface SelfExportRun {
  /** 边跑边填。跑完之后才是最终值 —— finishExport 要等流结束再调 */
  counts: ExportCounts;
  stream: AsyncGenerator<Uint8Array>;
}

/**
 * 一次导出的全部内容，一个 zip 字节流。
 *
 * 文件顺序不是随意的：README 在最前（解压后第一眼就该看到
 * 「这里面有别人的发言」），manifest 在最后 —— 它要写各文件的
 * **真实条数**，而条数只有在前面都写完之后才知道。
 * zip 的中央目录本来就在文件尾部，条目顺序对解压器无所谓。
 */
export function selfExportZip(
  user: CurrentUser,
  options: { withContext: boolean; now?: number },
): SelfExportRun {
  const now = options.now ?? Date.now();
  const counts = emptyCounts();
  const source = createExportSource(user);
  const streamOptions: StreamOptions = {
    withContext: options.withContext,
    selfWxId: user.wxId,
  };

  // 群聊和论坛共用同一套代号，同一个人在两个文件里才是同一个 pN
  const names = createPseudonyms(user.wxId);
  const visibleGroups = visibleGroupsFor(user).length;

  const manifestInput = () => ({
    exportedAt: now,
    exportedAtLocal: csvTime(now),
    userId: user.id,
    withContext: options.withContext,
    counts,
    visibleGroups,
  });

  async function* entries(): AsyncGenerator<ZipEntry> {
    yield { name: FILES.readme, mtime: now, content: () => once(buildReadme(manifestInput())) };
    yield { name: FILES.profile, mtime: now, content: () => once(profileOf(user, visibleGroups)) };
    yield {
      name: FILES.messages,
      mtime: now,
      content: () => messageLines(source, streamOptions, counts, names),
    };
    yield { name: FILES.posts, mtime: now, content: () => postLines(source, counts) };
    yield {
      name: FILES.replies,
      mtime: now,
      content: () => replyLines(source, streamOptions, counts, names),
    };
    yield { name: FILES.drafts, mtime: now, content: () => draftLines(source, counts) };
    yield {
      name: FILES.interactions,
      mtime: now,
      content: () => interactionLines(source, counts),
    };

    // 走到这里前面几个文件都已经压完了，counts 才是真的
    counts.pseudonyms = names.size();
    yield {
      name: FILES.manifest,
      mtime: now,
      content: () => once(`${JSON.stringify(buildManifest(manifestInput()), null, 2)}\n`),
    };
  }

  return { counts, stream: zipStream(entries(), now) };
}
