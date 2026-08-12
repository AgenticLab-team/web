"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import {
  createPostAs,
  createReplyAs,
  fail,
  mentionResolver,
  type ActionResult,
} from "@/lib/forum/write";
import { assertNotPreviewing, getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { postRevisions, postViews, posts, replies } from "@/lib/db/schema";
import { renderMarkdown } from "@/lib/markdown";
import { can } from "@/lib/rbac/can";

import { checkContent, fileForReview } from "@/lib/moderation/word-gate";

import { buildViewerContext } from "./context";
import { indexPost } from "./search";
import { canSeePost } from "./visibility";
import { canEditReply, checkReplyContent } from "./reply-rules";

/**
 * 论坛写操作。
 *
 * 每一条都要过三道：权限点 → 版块规则 → 频率与反滥用。
 * 顺序不能反 —— 先做贵的检查（查数据库算频率）再判权限，
 * 等于给没权限的人也提供了一个消耗资源的入口。
 */

/*
 * ActionResult / fail / 限流 / 新人外链提示都搬去了 write.ts ——
 * 那边是发帖回帖的真正实现，而这些辅助只服务于它们。
 * 这里 re-export 类型，是因为一堆组件按 `@/lib/forum/actions` 引用它。
 */
export type { ActionResult };


/**
 * 发帖 —— 网页那条路。
 *
 * 真正的规则在 `write.ts`：开放 API 也要发帖，而那条路上没有 cookie 会话。
 * 这里只做一件事：**把「你是谁」这个问题回答掉**，然后交给同一段实现。
 *
 * 参数类型直接取 `createPostAs` 的第二个参数 —— 手抄一份的话，
 * 加了新字段而忘了改这里，表现是网页上那个新功能静默失效。
 */
export async function createPost(
  input: Parameters<typeof createPostAs>[1],
): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user) return fail("请先登录");
  return createPostAs(user, input);
}

export async function createReply(
  input: Parameters<typeof createReplyAs>[1],
): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user) return fail("请先登录");
  return createReplyAs(user, input);
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
      /*
       * 改过就标，**没有「小改不算」这一说**。
       *
       * 给出「改动很小就不标记」的口子之后，它会被用来悄悄改掉
       * 一句话的意思 —— 而那正是最需要标出来的那种改动。
       *
       * （这段理由原来挂在 reply-rules 里一个恒返回 true 的
       *   `shouldMarkEdited()` 上，而那个函数没有任何调用方 ——
       *   规则写在一个没人问的地方，等于没写。现在它就在这一行旁边。）
       */
      editCount: sql`${replies.editCount} + 1`,
      lastEditedAt: Date.now(),
    })
    .where(eq(replies.id, reply.id))
    .run();

  revalidatePath(`/forum/p/${reply.postId}`);
  return { ok: true };
}
