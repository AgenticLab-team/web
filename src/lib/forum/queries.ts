import "server-only";

import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { boards, people, posts, replies, users } from "@/lib/db/schema";
import type { Visibility } from "@/lib/db/schema/forum";
import { resolveDisplayName } from "@/lib/users/display-name";

import { isEffectivelyPinned } from "./pin";
import { canSeePost, type PostVisibilityInfo, type ViewerContext } from "./visibility";
import { canEditReply } from "./reply-rules";

/**
 * 论坛查询。
 *
 * **可见性在这一层收口，不留给页面自己判断。**
 * 页面里散着写 if 迟早会漏一处，而漏的那一处就是泄露。
 *
 * 做法是两段式：SQL 先把明显不可见的滤掉（走索引，快），
 * 再用纯函数逐条精判（覆盖 role/group 这类 SQL 不好表达的规则）。
 * SQL 那一步只做粗筛，绝不能作为唯一防线。
 */

export interface PostSummary {
  id: string;
  title: string;
  excerpt: string | null;
  type: string;
  visibility: Visibility;
  authorId: string;
  authorName: string;
  authorAvatar: string | null;
  /**
   * 作者主页的落点。**匿名帖必须是 null** ——
   * 点进去就是本人，那等于没有匿名。
   */
  authorWxId: string | null;
  anonymous: boolean;
  boardId: string;
  boardKey: string;
  boardName: string;
  pinned: boolean;
  /** 置顶到什么时候；null = 管理员手动置顶，不会到期 */
  pinnedUntil: number | null;
  featured: boolean;
  solved: boolean;
  replyCount: number;
  reactionCount: number;
  viewCount: number;
  createdAt: number;
  lastReplyAt: number | null;
}

/** SQL 粗筛：能用索引排除的先排除掉 */
function coarseVisibilityFilter(viewer: ViewerContext) {
  const allowed: Visibility[] = ["public", "unlisted"];
  if (viewer.kind === "member" || viewer.kind === "external") allowed.push("member");
  // role 与 group 交给精判，private 只有作者和管理员能看
  allowed.push("role", "group");

  const conditions = [inArray(posts.visibility, allowed)];
  if (viewer.userId) {
    return or(and(...conditions), eq(posts.authorId, viewer.userId));
  }
  return and(...conditions);
}

/** 导出给首页摘要复用 —— 可见性字段的映射只能有一处 */
export function toVisibilityInfo(row: typeof posts.$inferSelect): PostVisibilityInfo {
  return {
    visibility: row.visibility,
    visibilityRoleId: row.visibilityRoleId,
    visibilityGroupId: row.visibilityGroupId,
    authorId: row.authorId,
    status: row.status,
    fromGroupChat: row.visibilityLocked,
  };
}

export interface ListPostsOptions {
  boardId?: string;
  authorId?: string;
  sort?: "recent" | "created" | "hot" | "unanswered";
  limit?: number;
  offset?: number;
}

export function listPosts(viewer: ViewerContext, options: ListPostsOptions = {}) {
  const conditions = [
    isNull(posts.deletedAt),
    ne(posts.status, "deleted"),
    // 草稿只在作者自己的列表里出现
    viewer.userId
      ? or(ne(posts.status, "draft"), eq(posts.authorId, viewer.userId))
      : ne(posts.status, "draft"),
    coarseVisibilityFilter(viewer),
  ];
  if (options.boardId) conditions.push(eq(posts.boardId, options.boardId));
  if (options.authorId) conditions.push(eq(posts.authorId, options.authorId));

  /*
   * 排序里用的是「现在还置顶着吗」，不是 pinned 这个布尔。
   *
   * 只看布尔的话，一次「置顶一天」会变成置顶到天荒地老 ——
   * 而且没有任何地方看得出来：帖子就在那儿，看起来一切正常。
   */
  const stillPinned = sql`(${posts.pinned} = 1 AND (${posts.pinnedUntil} IS NULL OR ${posts.pinnedUntil} > ${Date.now()}))`;

  const order = {
    recent: [desc(stillPinned), desc(sql`COALESCE(${posts.lastReplyAt}, ${posts.createdAt})`)],
    created: [desc(stillPinned), desc(posts.createdAt)],
    // 热度按时间衰减，否则永远是那几个老帖霸榜
    hot: [
      desc(stillPinned),
      desc(sql`(${posts.reactionCount} * 3 + ${posts.replyCount} * 2 + ${posts.viewCount} * 0.05)
               / (((${Date.now()} - ${posts.createdAt}) / 3600000.0) + 2)`),
    ],
    unanswered: [asc(posts.replyCount), desc(posts.createdAt)],
  }[options.sort ?? "recent"];

  // 精判会滤掉一部分，所以先多取一些，避免翻页时页面变空
  const overFetch = (options.limit ?? 20) * 3;

  const rows = db
    .select({ post: posts, board: boards })
    .from(posts)
    .innerJoin(boards, eq(boards.id, posts.boardId))
    .where(and(...conditions))
    .orderBy(...order)
    .limit(overFetch)
    .offset(options.offset ?? 0)
    .all();

  const visible = rows.filter((r) => canSeePost(toVisibilityInfo(r.post), viewer).visible);
  const page = visible.slice(0, options.limit ?? 20);

  return hydrateAuthors(page.map((r) => ({ post: r.post, board: r.board })));
}

function hydrateAuthors(rows: { post: typeof posts.$inferSelect; board: typeof boards.$inferSelect }[]): PostSummary[] {
  if (rows.length === 0) return [];

  const authorIds = [...new Set(rows.map((r) => r.post.authorId))];
  const authors = new Map(
    db
      .select({
        id: users.id,
        wxId: users.wxId,
        siteNickname: users.siteNickname,
        wxNickname: users.wxNickname,
        avatar: users.wxAvatarUrl,
      })
      .from(users)
      .where(inArray(users.id, authorIds))
      .all()
      .map((u) => [u.id, u]),
  );

  const wxIds = [...authors.values()].map((a) => a.wxId).filter(Boolean) as string[];
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

  return rows.map(({ post, board }) => {
    const author = authors.get(post.authorId);
    const profile = author?.wxId ? profiles.get(author.wxId) : undefined;
    return {
      id: post.id,
      title: post.title,
      excerpt: post.excerpt,
      type: post.type,
      visibility: post.visibility,
      authorId: post.authorId,
      // 匿名帖不暴露作者，连头像都不给 —— 头像同样能认出人
      authorName: post.anonymous
        ? "匿名"
        : // people.displayName 的存量数据里混着 wx_id，必须走统一解析过滤
          resolveDisplayName([author?.siteNickname, author?.wxNickname, profile?.name], {
            wxId: author?.wxId,
            fallback: "成员",
          }),
      authorAvatar: post.anonymous ? null : (author?.avatar ?? profile?.avatar ?? null),
      // 同上：匿名帖连主页链接都不能给
      authorWxId: post.anonymous ? null : (author?.wxId ?? null),
      anonymous: post.anonymous,
      boardId: board.id,
      boardKey: board.key,
      boardName: board.name,
      // 列表上显示的也要是「现在还置顶着」，否则过期的会一直带着置顶标
      pinned: isEffectivelyPinned(post, Date.now()),
      pinnedUntil: post.pinnedUntil,
      featured: post.featured,
      solved: Boolean(post.solvedReplyId),
      replyCount: post.replyCount,
      reactionCount: post.reactionCount,
      viewCount: post.viewCount,
      createdAt: post.createdAt,
      lastReplyAt: post.lastReplyAt,
    };
  });
}

/** 取单帖。看不见时返回 null，调用方渲染 404 —— 403 会泄露存在性 */
export function getPost(viewer: ViewerContext, postId: string) {
  const row = db
    .select({ post: posts, board: boards })
    .from(posts)
    .innerJoin(boards, eq(boards.id, posts.boardId))
    .where(eq(posts.id, postId))
    .get();
  if (!row) return null;

  const verdict = canSeePost(toVisibilityInfo(row.post), viewer);
  if (!verdict.visible) return null;

  const [summary] = hydrateAuthors([row]);
  return { ...summary, contentHtml: row.post.contentHtml, content: row.post.content, board: row.board, raw: row.post };
}

export function listReplies(viewer: ViewerContext, postId: string) {
  /*
   * 时钟只读一次，在这里读。
   *
   * 逐条读的话同一屏上早的和晚的回复会用上不同的「现在」，
   * 而在页面组件里读又是渲染期副作用（React 编译器会拦，拦得对）。
   */
  const now = Date.now();
  const rows = db
    .select()
    .from(replies)
    .where(
      and(
        eq(replies.postId, postId),
        viewer.canModerate ? undefined : ne(replies.status, "deleted"),
      ),
    )
    .orderBy(asc(replies.floor))
    .all();

  if (rows.length === 0) return [];

  const authorIds = [...new Set(rows.map((r) => r.authorId))];
  const authors = new Map(
    db
      .select({
        id: users.id,
        wxId: users.wxId,
        siteNickname: users.siteNickname,
        wxNickname: users.wxNickname,
        avatar: users.wxAvatarUrl,
      })
      .from(users)
      .where(inArray(users.id, authorIds))
      .all()
      .map((u) => [u.id, u]),
  );

  return rows.map((r) => {
    const author = authors.get(r.authorId);
    return {
      id: r.id,
      floor: r.floor,
      contentHtml: r.contentHtml,
      authorId: r.authorId,
      authorName: r.anonymous
        ? "匿名"
        : resolveDisplayName([author?.siteNickname, author?.wxNickname], {
            wxId: author?.wxId,
            fallback: "成员",
          }),
      authorAvatar: r.anonymous ? null : (author?.avatar ?? null),
      // 匿名回复不给主页链接 —— 点进去就是本人
      authorWxId: r.anonymous ? null : (author?.wxId ?? null),
      accepted: r.accepted,
      // 原文（markdown）—— 编辑时要拿它填输入框，渲染后的 HTML 回不去
      content: r.content,
      collapsed: r.collapsed,
      collapseReason: r.collapseReason,
      status: r.status,
      // 树形视图按 parentId 排；quoted* 只管那一小段引文的显示
      parentId: r.parentId,
      quotedReplyId: r.quotedReplyId,
      quotedExcerpt: r.quotedExcerpt,
      reactionCount: r.reactionCount,
      editCount: r.editCount,
      createdAt: r.createdAt,
      isMine: viewer.userId === r.authorId,
      /*
       * 能不能改在这里算，和 isMine 一样。
       *
       * 放到页面组件里算的话要在渲染期读时钟 —— 那既不纯
       * （React 编译器会拦，拦得对），又会让同一屏上早晚不同的回复
       * 用上不同的「现在」。
       */
      canEdit: canEditReply({
        isAuthor: viewer.userId === r.authorId,
        status: r.status,
        createdAt: r.createdAt,
        now,
      }).ok,
    };
  });
}

/** 版块列表。版块自身的可见性也要判 —— 看不到的版块不该出现在导航里 */
export function listBoards(viewer: ViewerContext) {
  const rows = db
    .select()
    .from(boards)
    .where(isNull(boards.deletedAt))
    .orderBy(asc(boards.sort), asc(boards.createdAt))
    .all();

  return rows.filter((board) => {
    switch (board.visibleTo) {
      case "public":
      case "unlisted":
        return true;
      case "member":
        return viewer.kind !== null;
      default:
        return viewer.canModerate || viewer.kind === "member";
    }
  });
}

export function getBoardByKey(key: string) {
  return db.select().from(boards).where(and(eq(boards.key, key), isNull(boards.deletedAt))).get();
}
