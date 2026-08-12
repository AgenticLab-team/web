import "server-only";

import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { boards, people, posts, replies, users } from "@/lib/db/schema";
import type { Visibility } from "@/lib/db/schema/forum";
import { defangHtml, defangedAuthorHint, isNewbie } from "@/lib/moderation/link-defang-rules";
import { siteHosts } from "@/lib/moderation/site-hosts";
import { getSettingInt } from "@/lib/settings/store";
import { resolveDisplayName } from "@/lib/users/display-name";

import { charCountOf, LONGFORM_CHARS } from "./longform";
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
  /**
   * 正文有多少字 —— 列表上要据此显示「读完大概几分钟」。
   *
   * 在这里算而不是把正文一路带到组件里：正文最长的那篇一万三千字，
   * 十五条一页就是二十万字穿过 RSC 边界，而屏幕上只会显示「45 分钟」。
   */
  charCount: number;
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
  sort?: "recent" | "created" | "hot" | "unanswered" | "deep";
  limit?: number;
  offset?: number;
  /**
   * 只要「值得坐下来读」的：站长标过精华的，或者正文够长的。
   *
   * 存在的理由见 longform.ts —— 一句话是：这个站现在会把长文冲走。
   */
  longformOnly?: boolean;
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
  if (options.authorId) {
    conditions.push(eq(posts.authorId, options.authorId));
    /*
     * ─────────────────────────────────────────
     * 按作者筛的列表里**永远没有匿名帖**
     * ─────────────────────────────────────────
     *
     * 一篇匿名帖出现在「这个人发过的帖」里，匿名当场作废 ——
     * 而这一条比它听起来更容易漏：查询层已经把名字、头像、
     * 主页链接都抹了，所以这个列表看起来是干净的，
     * 只是它出现在**谁的主页上**这件事本身就是答案。
     *
     * 连作者自己看也排除。「除了作者本人」这种例外听起来更周到，
     * 实际是这个仓库反复出错的形状：规则在一条路上成立、
     * 在另一条路上不成立 —— 而哪天这个列表被做成分享卡片、
     * OG 图或者导出，那条例外就成了泄露口。
     * 一条没有例外的规则，才是没法写错的规则。
     */
    conditions.push(eq(posts.anonymous, false));
  }

  /*
   * 排序里用的是「现在还置顶着吗」，不是 pinned 这个布尔。
   *
   * 只看布尔的话，一次「置顶一天」会变成置顶到天荒地老 ——
   * 而且没有任何地方看得出来：帖子就在那儿，看起来一切正常。
   */
  const stillPinned = sql`(${posts.pinned} = 1 AND (${posts.pinnedUntil} IS NULL OR ${posts.pinnedUntil} > ${Date.now()}))`;

  /*
   * 「值得读」= 站长标了精华，**或者**正文够长。
   *
   * 两条都要：只认精华的话，这个位置永远只有站长手点过的那几篇，
   * 而现在全站一共两篇；只认长度的话，一篇长而水的帖子和一篇
   * 被认可的短文待遇一样。
   *
   * `length()` 在 SQLite 里数的是字符不是字节（正文列是 TEXT），
   * 所以中文不会被算成三倍。这一点值得写下来 ——
   * 用 `length(cast(content as blob))` 就会。
   */
  if (options.longformOnly) {
    conditions.push(
      sql`(${posts.featured} = 1 OR length(${posts.content}) >= ${LONGFORM_CHARS})`,
    );
  }

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
    /*
     * 「深度」排序 —— 给长文用的，和 hot 的关键差别是**衰减慢得多**。
     *
     * hot 的分母是「小时数 + 2」，一篇帖子一天之后就基本沉了。
     * 那对快讯是对的，对一篇讲架构的长文是错的：它半年后还成立，
     * 而写它花了一天。这里分母按**天**算，再加 7 天的缓冲 ——
     * 于是一篇好文的架子能挂一两个月，而不是一个下午。
     *
     * 精华权重给得很重（+50），因为那是唯一一个「有人真的读过并且
     * 认为值得」的信号 —— 浏览和回复都可以是路过。
     */
    deep: [
      desc(stillPinned),
      desc(sql`(${posts.featured} * 50
                + ${posts.reactionCount} * 3
                + ${posts.replyCount} * 2
                + ${posts.viewCount} * 0.2)
               / (((${Date.now()} - ${posts.createdAt}) / 86400000.0) + 7)`),
    ],
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
      // 按码点数，`.length` 会把每个 emoji 数成两个 —— 见 longform.ts
      charCount: charCountOf(post.content),
      solved: Boolean(post.solvedReplyId),
      replyCount: post.replyCount,
      reactionCount: post.reactionCount,
      viewCount: post.viewCount,
      createdAt: post.createdAt,
      lastReplyAt: post.lastReplyAt,
    };
  });
}

/**
 * 新人外链降权：**在这一层做，不在写入那一层做**。
 *
 * 库里存的永远是原文（`content` 和渲染好的 `contentHtml` 都是原样），
 * 拆点只发生在读出来的这一瞬间。这样「满没满 N 天」变化时，
 * 老帖子里的链接会自己好起来 —— 写入时拆的话，人满 3 天之后回头看，
 * 自己的链接永远是残废的，而那正是「再等等就好」这句承诺的反面。
 *
 * 代价是每一条渲染路径都要经过这里。目前 `contentHtml` 只有两个
 * 出口（单帖正文、楼层），都在这个文件里；新开渲染路径的话必须
 * 一起走这一步，否则就是一个绕过口。别的出口（列表页的 excerpt、
 * 搜索、群聊同步）都是纯文本，本来就点不动，不在这条链路上。
 */
function defangFor(
  html: string,
  firstBoundAt: number | null | undefined,
  now: number,
): { html: string; notice: string | null } {
  const days = getSettingInt("forum.newbie_no_link_days", 3);
  if (!isNewbie(firstBoundAt, days, now)) return { html, notice: null };

  const result = defangHtml(html, { siteHosts: siteHosts() });
  // 没拆到东西就别摆那句解释 —— 新人发的干净帖子不该被扣一顶帽子
  return { html: result.html, notice: result.count > 0 ? defangedAuthorHint(days) : null };
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

  // 时钟在这里读一次 —— 页面组件里读是渲染期副作用，React 编译器会拦
  const author = db
    .select({ firstBoundAt: users.firstBoundAt })
    .from(users)
    .where(eq(users.id, row.post.authorId))
    .get();
  const defanged = defangFor(row.post.contentHtml, author?.firstBoundAt, Date.now());

  return {
    ...summary,
    contentHtml: defanged.html,
    /** 正文里的链接被降权了 —— 作者自己看时要解释一句，否则只会以为站坏了 */
    linkNotice: defanged.notice,
    content: row.post.content,
    board: row.board,
    raw: row.post,
  };
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
        // 新人外链降权要用；和上面的 now 一样，判定在这一层做完
        firstBoundAt: users.firstBoundAt,
      })
      .from(users)
      .where(inArray(users.id, authorIds))
      .all()
      .map((u) => [u.id, u]),
  );

  return rows.map((r) => {
    const author = authors.get(r.authorId);
    const defanged = defangFor(r.contentHtml, author?.firstBoundAt, now);
    return {
      id: r.id,
      floor: r.floor,
      contentHtml: defanged.html,
      /** 这一楼的链接被降权了。只有作者自己看得到那句解释 */
      linkNotice: defanged.notice,
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
      // 标志本身要传出去 —— 页面得知道该不该拿 authorId 当配色种子
      anonymous: r.anonymous,
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
