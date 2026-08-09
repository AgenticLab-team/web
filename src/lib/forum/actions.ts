"use server";

import { and, count, eq, gt, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { assertNotPreviewing, getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { boards, pollOptions, polls, postRevisions, postViews, posts, replies, users } from "@/lib/db/schema";
import { renderMarkdown } from "@/lib/markdown";
import { can } from "@/lib/rbac/can";
import { getSettingInt } from "@/lib/settings/store";
import { resolveDisplayName } from "@/lib/users/display-name";

import { checkContent, fileForReview } from "@/lib/moderation/word-gate";

import { recountBoardPosts } from "./board-stats";
import { buildViewerContext } from "./context";
import { dropDraft } from "./drafts";
import { autoSubscribe, notifyNewPost, notifyNewReply } from "./notify";
import { getPost } from "./queries";
import { indexPost, indexReply } from "./search";
import { canSeePost, normalizePostVisibility } from "./visibility";
import { checkClosesAt, normalizePollDraft } from "./poll-rules";
import { canEditReply, checkReplyContent } from "./reply-rules";

/**
 * 论坛写操作。
 *
 * 每一条都要过三道：权限点 → 版块规则 → 频率与反滥用。
 * 顺序不能反 —— 先做贵的检查（查数据库算频率）再判权限，
 * 等于给没权限的人也提供了一个消耗资源的入口。
 */

export interface ActionResult {
  ok: boolean;
  error?: string;
  postId?: string;
  replyId?: string;
}

const fail = (error: string): ActionResult => ({ ok: false, error });

/** 提及解析：把 @昵称 映射到账号 id */
function mentionResolver() {
  const rows = db
    .select({
      id: users.id,
      siteNickname: users.siteNickname,
      wxNickname: users.wxNickname,
    })
    .from(users)
    .all();

  const byName = new Map<string, string>();
  for (const row of rows) {
    if (row.siteNickname) byName.set(row.siteNickname, row.id);
    if (row.wxNickname && !byName.has(row.wxNickname)) byName.set(row.wxNickname, row.id);
  }
  return (name: string) => byName.get(name) ?? null;
}

/**
 * 新人不能发外链。
 * 这是防广告最有效的一条 —— 广告号的特征就是刚进群就甩链接。
 */
function violatesNewbieLinkRule(user: { firstBoundAt: number | null }, content: string): boolean {
  const days = getSettingInt("forum.newbie_no_link_days", 3);
  if (days <= 0) return false;
  const boundAt = user.firstBoundAt;
  if (!boundAt) return true;
  if (Date.now() - boundAt > days * 86_400_000) return false;
  return /https?:\/\//i.test(content);
}

function tooFrequent(userId: string, table: "post" | "reply"): boolean {
  const windowMs = getSettingInt("forum.rate_window_seconds", 600) * 1000;
  const max = getSettingInt(
    table === "post" ? "forum.max_posts_per_window" : "forum.max_replies_per_window",
    table === "post" ? 3 : 15,
  );
  const since = Date.now() - windowMs;

  const n =
    table === "post"
      ? db
          .select({ n: count() })
          .from(posts)
          .where(and(eq(posts.authorId, userId), gt(posts.createdAt, since)))
          .get()?.n
      : db
          .select({ n: count() })
          .from(replies)
          .where(and(eq(replies.authorId, userId), gt(replies.createdAt, since)))
          .get()?.n;

  return (n ?? 0) >= max;
}

export async function createPost(input: {
  boardKey: string;
  title: string;
  content: string;
  type?: "discussion" | "question" | "showcase";
  visibility?: "public" | "unlisted" | "member" | "private";
  anonymous?: boolean;
  /**
   * 顺带建一个投票。
   *
   * **和帖子在同一个事务里建**，不是发完帖再调一次 createPoll ——
   * 那样中间失败会留下一个「类型是投票、但没有投票」的帖子，
   * 而界面上那种帖子看起来就是坏的，作者也修不了。
   */
  poll?: {
    question?: string;
    options: string[];
    multi?: boolean;
    hideUntilVoted?: boolean;
    closesAt?: number;
  };
}): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user) return fail("请先登录");

  const board = db.select().from(boards).where(eq(boards.key, input.boardKey)).get();
  if (!board) return fail("版块不存在");
  if (board.locked) return fail("该版块已锁定");

  // ① 权限点
  const permission = (board.postPermission ?? "forum.post.create") as "forum.post.create";
  const verdict = can(user, permission, { scopeType: "board", scopeId: board.id });
  if (!verdict.allowed) return fail(verdict.reason);

  // ② 版块规则
  if (user.level < board.postMinLevel) {
    return fail(`该版块需要 L${board.postMinLevel} 才能发帖，你当前 L${user.level}`);
  }
  if (input.anonymous && !board.allowAnonymous) return fail("该版块不允许匿名发帖");

  const title = input.title.trim();
  const content = input.content.trim();
  if (title.length < 2) return fail("标题太短了");
  if (title.length > 120) return fail("标题不能超过 120 字");
  if (content.length < 2) return fail("正文不能为空");

  // ③ 反滥用
  if (violatesNewbieLinkRule(user, content)) {
    const days = getSettingInt("forum.newbie_no_link_days", 3);
    return fail(`加入不满 ${days} 天暂时不能发外链，等等再来`);
  }
  if (tooFrequent(user.id, "post")) return fail("发帖太频繁了，歇一会儿");

  /*
   * ④ 敏感词。
   *
   * 标题和正文**分开扫**。拼成一段再扫看着省事，但替换档会改写文本，
   * 拼接后再按原长度切回来，只要标题里发生过替换，切点就错了 ——
   * 结果是正文开头被啃掉几个字。
   * 只扫正文同样不行：把词放标题里就绕过去了。
   */
  const titleGate = checkContent(title);
  if (!titleGate.allowed) return fail(titleGate.message!);
  const contentGate = checkContent(content);
  if (!contentGate.allowed) return fail(contentGate.message!);

  const safeTitle = titleGate.content;
  const safeContent = contentGate.content;
  const needsReview = titleGate.needsReview || contentGate.needsReview;

  const rendered = await renderMarkdown(safeContent, { resolveMention: mentionResolver() });

  const normalized = normalizePostVisibility({
    requested: input.visibility ?? board.defaultVisibility,
    boardMax: board.maxVisibility,
  });

  /*
   * 投票的校验放在开事务**之前**。
   *
   * 放进去的话，一个「只填了一个选项」这样的小错会连累整篇帖子回滚 ——
   * 而人刚写完两千字。校验和落库分开，错了只需要改那两行选项。
   */
  let pollDraft: { options: string[]; question: string | null } | null = null;
  if (input.poll) {
    const check = normalizePollDraft(input.poll);
    if (!check.ok) return fail(check.error);
    const timeCheck = checkClosesAt(input.poll.closesAt, Date.now());
    if (timeCheck && !timeCheck.ok) return fail(timeCheck.error);
    pollDraft = { options: check.options, question: check.question };
  }

  const created = db.transaction((tx) => {
    const row = tx
      .insert(posts)
      .values({
        boardId: board.id,
        authorId: user.id,
        title: safeTitle,
        content: safeContent,
        contentHtml: rendered.html,
        excerpt: rendered.excerpt,
        // 带了投票就是投票帖 —— 类型和内容在同一个事务里定下来，不会对不上
        type: pollDraft ? "poll" : (input.type ?? "discussion"),
        status: "published",
        visibility: normalized.visibility,
        visibilityGroupId: normalized.visibilityGroupId,
        visibilityLocked: normalized.locked,
        anonymous: Boolean(input.anonymous),
        shareCode: Math.random().toString(36).slice(2, 10),
      })
      .returning({ id: posts.id })
      .get();

    if (pollDraft) {
      const poll = tx
        .insert(polls)
        .values({
          postId: row.id,
          question: pollDraft.question,
          multi: Boolean(input.poll?.multi),
          hideUntilVoted: Boolean(input.poll?.hideUntilVoted),
          closesAt: input.poll?.closesAt,
        })
        .returning({ id: polls.id })
        .get();

      pollDraft.options.forEach((text, sort) => {
        tx.insert(pollOptions).values({ pollId: poll.id, text, sort }).run();
      });
    }

    // 计数统一走重算，不再手写 +1 —— 「+1」是第二份真相，
    // 群聊转帖那条路当年就是忘了抄这一句，沉淀版因此常年显示 0
    recountBoardPosts(board.id, tx);
    tx.update(boards).set({ lastPostAt: Date.now() }).where(eq(boards.id, board.id)).run();

    return row;
  });

  indexPost(created.id, safeTitle, safeContent);

  // 送审档照常发布，只是进队列。先扣下再审的话，误伤一次就是
  // 有人的内容凭空消失几小时，而子串匹配的误伤率注定不低
  if (needsReview) {
    fileForReview({
      targetType: "post",
      targetId: created.id,
      targetUserId: user.id,
      scan: titleGate.needsReview ? titleGate.scan : contentGate.scan,
    });
  }

  /*
   * 发出去了就把服务端草稿删掉。
   *
   * 不删的话，下次点「发帖」会把**已经发表过的内容**当草稿恢复出来 ——
   * 而人多半会以为上次没发成功，于是再发一遍。
   */
  dropDraft(user.id, "post", board.key);

  // 发帖后自动订阅自己的帖子，有人回复才收得到通知
  autoSubscribe(user.id, created.id);

  /*
   * 扇给关注这个作者 / 版块 / 标签的人。
   *
   * 在这一行之前，**发新帖不通知任何人** —— 站里只有
   * notifyNewReply，而 subscriptions.target_type 里的
   * user / board / tag 三个值从来没有一行数据。
   *
   * 逐人可见性判定在 notifyNewPost 里面做，不在这里 ——
   * 放在调用点的话，下一个调用点（转帖、定时发布）就会忘掉。
   */
  notifyNewPost({
    postId: created.id,
    title: safeTitle,
    authorId: user.id,
    // 匿名与否由 notifyNewPost 自己从帖子行上判 —— 调用点判的话，
    // 下一个调用点（转帖、定时发布）会忘掉，而忘掉的后果是匿名失效
    authorName: resolveDisplayName([user.siteNickname, user.wxNickname], {
      wxId: user.wxId,
      fallback: "有人",
    }),
    boardId: board.id,
    boardName: board.name,
  });

  audit({ actorId: user.id }, {
    action: "forum.post.create",
    targetType: "post",
    targetId: created.id,
    targetLabel: title,
    after: { boardKey: board.key, visibility: normalized.visibility },
  });

  revalidatePath("/forum");
  revalidatePath(`/forum/${board.key}`);
  return { ok: true, postId: created.id };
}

export async function createReply(input: {
  postId: string;
  content: string;
  quotedReplyId?: string;
  anonymous?: boolean;
}): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user) return fail("请先登录");

  const viewer = buildViewerContext(user);
  const post = getPost(viewer, input.postId);
  // 看不见的帖子不能回复，且错误信息与「不存在」一致，不泄露存在性
  if (!post) return fail("帖子不存在");
  if (post.raw.status === "locked") return fail("该帖已锁定，不能再回复");

  const board = post.board;
  const permission = (board.replyPermission ?? "forum.reply.create") as "forum.reply.create";
  const verdict = can(user, permission, { scopeType: "board", scopeId: board.id });
  if (!verdict.allowed) return fail(verdict.reason);

  const content = input.content.trim();
  if (content.length < 1) return fail("回复不能为空");
  if (violatesNewbieLinkRule(user, content)) {
    const days = getSettingInt("forum.newbie_no_link_days", 3);
    return fail(`加入不满 ${days} 天暂时不能发外链`);
  }
  if (tooFrequent(user.id, "reply")) return fail("回复太频繁了，歇一会儿");

  const gate = checkContent(content);
  if (!gate.allowed) return fail(gate.message!);
  const safeReply = gate.content;

  const rendered = await renderMarkdown(safeReply, { resolveMention: mentionResolver() });

  const created = db.transaction((tx) => {
    /*
     * 楼层号必须在事务里算。两个人同时回复时，
     * 事务外算 max+1 会得到同一个楼层号，撞上唯一索引其中一个直接失败。
     */
    const maxFloor =
      tx
        .select({ max: sql<number>`COALESCE(MAX(${replies.floor}), 0)` })
        .from(replies)
        .where(eq(replies.postId, input.postId))
        .get()?.max ?? 0;

    let quotedExcerpt: string | null = null;
    if (input.quotedReplyId) {
      const quoted = tx.select().from(replies).where(eq(replies.id, input.quotedReplyId)).get();
      // 只引用同一帖内的回复，避免跨帖拼接出误导性的上下文
      if (quoted && quoted.postId === input.postId) {
        quotedExcerpt = quoted.content.slice(0, 80);
      }
    }

    const row = tx
      .insert(replies)
      .values({
        postId: input.postId,
        authorId: user.id,
        content: safeReply,
        contentHtml: rendered.html,
        floor: maxFloor + 1,
        quotedReplyId: input.quotedReplyId,
        quotedExcerpt,
        anonymous: Boolean(input.anonymous),
      })
      .returning({ id: replies.id, floor: replies.floor })
      .get();

    tx.update(posts)
      .set({
        replyCount: sql`${posts.replyCount} + 1`,
        lastReplyAt: Date.now(),
      })
      .where(eq(posts.id, input.postId))
      .run();

    return row;
  });

  indexReply(input.postId, created.id, safeReply);
  // 回复发出去了，服务端那份草稿也该没了
  dropDraft(user.id, "reply", input.postId);

  autoSubscribe(user.id, input.postId);

  if (gate.needsReview) {
    fileForReview({
      targetType: "reply",
      targetId: created.id,
      targetUserId: user.id,
      scan: gate.scan,
    });
  }

  notifyNewReply({
    postId: input.postId,
    postTitle: post.title,
    postAuthorId: post.authorId,
    replyAuthorId: user.id,
    replyAuthorName: input.anonymous
      ? "匿名"
      : resolveDisplayName([user.siteNickname, user.wxNickname], {
          wxId: user.wxId,
          fallback: "有人",
        }),
    floor: created.floor,
    mentions: rendered.mentions,
  });

  revalidatePath(`/forum/p/${input.postId}`);
  return { ok: true, replyId: created.id };
}

export async function editPost(input: {
  postId: string;
  title: string;
  content: string;
  changeNote?: string;
}): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user) return fail("请先登录");

  const existing = db.select().from(posts).where(eq(posts.id, input.postId)).get();
  if (!existing) return fail("帖子不存在");

  const viewer = buildViewerContext(user, existing.boardId);
  if (!canSeePost(
    {
      visibility: existing.visibility,
      visibilityRoleId: existing.visibilityRoleId,
      visibilityGroupId: existing.visibilityGroupId,
      authorId: existing.authorId,
      status: existing.status,
      fromGroupChat: existing.visibilityLocked,
    },
    viewer,
  ).visible) {
    return fail("帖子不存在");
  }

  const isAuthor = existing.authorId === user.id;
  const permission = isAuthor ? "forum.post.edit.own" : "forum.post.edit.any";
  const verdict = can(user, permission, { scopeType: "board", scopeId: existing.boardId });
  if (!verdict.allowed) return fail(verdict.reason);

  const title = input.title.trim();
  const content = input.content.trim();
  if (title.length < 2) return fail("标题太短了");
  if (content.length < 2) return fail("正文不能为空");
  if (title === existing.title && content === existing.content) return { ok: true, postId: existing.id };

  // 编辑是最明显的绕过口：先发一篇干净的，再编辑把词加进去
  const titleGate = checkContent(title);
  if (!titleGate.allowed) return fail(titleGate.message!);
  const contentGate = checkContent(content);
  if (!contentGate.allowed) return fail(contentGate.message!);

  const safeTitle = titleGate.content;
  const safeContent = contentGate.content;

  const rendered = await renderMarkdown(safeContent, { resolveMention: mentionResolver() });

  db.transaction((tx) => {
    // 先存旧版本再改 —— 顺序反了就丢了改动前的样子
    tx.insert(postRevisions)
      .values({
        postId: existing.id,
        editorId: user.id,
        title: existing.title,
        content: existing.content,
        changeNote: input.changeNote,
      })
      .run();

    tx.update(posts)
      .set({
        title: safeTitle,
        content: safeContent,
        contentHtml: rendered.html,
        excerpt: rendered.excerpt,
        editCount: sql`${posts.editCount} + 1`,
        lastEditedAt: Date.now(),
        updatedAt: Date.now(),
      })
      .where(eq(posts.id, existing.id))
      .run();
  });

  indexPost(existing.id, safeTitle, safeContent);

  if (titleGate.needsReview || contentGate.needsReview) {
    fileForReview({
      targetType: "post",
      targetId: existing.id,
      targetUserId: existing.authorId,
      scan: titleGate.needsReview ? titleGate.scan : contentGate.scan,
    });
  }

  audit({ actorId: user.id }, {
    action: isAuthor ? "forum.post.edit.own" : "forum.post.edit.any",
    targetType: "post",
    targetId: existing.id,
    targetLabel: title,
    before: { title: existing.title },
    after: { title },
    reason: input.changeNote,
  });

  revalidatePath(`/forum/p/${existing.id}`);
  return { ok: true, postId: existing.id };
}

/**
 * 记录浏览。
 *
 * 同一个人反复刷新不重复计数 —— 否则作者自己刷几下就能把数字顶上去，
 * 浏览量一旦可以自己制造就失去了参考价值。
 * 未登录的浏览不计入，也不留任何记录。
 */
export async function recordView(postId: string) {
  const user = await getCurrentUser();
  if (!user) return;

  const existing = db
    .select()
    .from(postViews)
    .where(and(eq(postViews.postId, postId), eq(postViews.userId, user.id)))
    .get();

  if (existing) {
    db.update(postViews)
      .set({ readAt: Date.now() })
      .where(and(eq(postViews.postId, postId), eq(postViews.userId, user.id)))
      .run();
    return;
  }

  db.transaction((tx) => {
    tx.insert(postViews).values({ postId, userId: user.id }).run();
    tx.update(posts)
      .set({ viewCount: sql`${posts.viewCount} + 1` })
      .where(eq(posts.id, postId))
      .run();
  });
}

/** 记住读到第几楼，回来时能跳回去 */
export async function markReadFloor(postId: string, floor: number) {
  const user = await getCurrentUser();
  if (!user) return;

  db.insert(postViews)
    .values({ postId, userId: user.id, lastReadFloor: floor })
    .onConflictDoUpdate({
      target: [postViews.postId, postViews.userId],
      // 只前进不后退：往回翻了一下不该把进度重置
      set: { lastReadFloor: sql`MAX(${postViews.lastReadFloor}, ${floor})`, readAt: Date.now() },
    })
    .run();
}

/**
 * 编辑自己的回复。
 *
 * ─────────────────────────────────────────
 * 走和发表时一模一样的内容管线
 * ─────────────────────────────────────────
 *
 * `checkContent`（敏感词）、`renderMarkdown`（净化 + @解析）一样都不能省。
 * 省掉的话编辑就成了**绕过审核的后门**：发一条干净的，
 * 然后编辑成任何内容 —— 而审核只看发表那一刻。
 *
 * ─────────────────────────────────────────
 * 改过就标，没有「小改不算」
 * ─────────────────────────────────────────
 *
 * 回复是对话的一部分，底下可能已经有人引用它、回应它。
 * 悄悄改掉一条被引用过的回复，会让后面那串回应看起来莫名其妙，
 * 而读的人只会觉得那些人在胡言乱语。
 *
 * `replies.edit_count` 这个列一直在库里、查询也读它 ——
 * 只是从来没有任何地方写过它，因为根本没有编辑的入口。
 */
export async function editReply(input: {
  replyId: string;
  content: string;
}): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user) return fail("请先登录");
  await assertNotPreviewing();

  const reply = db.select().from(replies).where(eq(replies.id, input.replyId)).get();
  if (!reply) return fail("回复不存在");

  const verdict = canEditReply({
    isAuthor: reply.authorId === user.id,
    status: reply.status,
    createdAt: reply.createdAt,
    now: Date.now(),
  });
  if (!verdict.ok) return fail(verdict.reason);

  const shape = checkReplyContent(input.content);
  if (!shape.ok) return fail(shape.reason);

  // 和发表时同一道闸 —— 少这一步，编辑就是绕过审核的后门
  const gate = checkContent(shape.content);
  if (!gate.allowed) return fail(gate.message!);

  const rendered = await renderMarkdown(gate.content, { resolveMention: mentionResolver() });

  db.update(replies)
    .set({
      content: gate.content,
      contentHtml: rendered.html,
      editCount: sql`${replies.editCount} + 1`,
      lastEditedAt: Date.now(),
    })
    .where(eq(replies.id, reply.id))
    .run();

  revalidatePath(`/forum/p/${reply.postId}`);
  return { ok: true };
}
