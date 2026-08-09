import "server-only";

import { eq } from "drizzle-orm";

import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { boards, moderationActions, posts, users } from "@/lib/db/schema";
import { can } from "@/lib/rbac/can";

import { recountBoardPosts } from "./board-stats";
import { canLock, canUnlock, checkLockReason } from "./lock-rules";
import { notify } from "./notify";
import { indexPost, removeFromIndex } from "./search";
import { capVisibility } from "./visibility";

/**
 * 帖子页行内管理：能力判定与各操作的核心实现。
 *
 * 为什么单独一层而不是全写进 "use server" 文件：
 * server action 里的 getCurrentUser 依赖请求上下文，测试根本调不到 ——
 * 而这里最不能不测的恰恰是权限边界（自己的帖 vs 别人的帖、
 * 版主的版块 vs 别的版块）。所以把身份作为显式参数传进来，
 * action 层只剩「取身份 → 调这里 → revalidate」三行，薄到不值得错。
 */

type Actor = typeof users.$inferSelect;
type PostRow = typeof posts.$inferSelect;

/**
 * 帖子页该给这个人显示哪些操作。
 *
 * 全部走 can()，一条 role 字符串判断都没有 —— 这是页面按钮的**显示**依据，
 * 不是授权本身：每个写操作在执行时还会再判一遍，
 * 客户端拼出来的请求不享受任何信任。
 */
export interface PostCaps {
  edit: boolean;
  deleteOwn: boolean;
  deleteAny: boolean;
  restore: boolean;
  feature: boolean;
  pin: boolean;
  /** 现在能不能锁 */
  lock: boolean;
  /**
   * 现在能不能解锁 —— 和 lock 分开。
   *
   * 合成一个的话，楼主就能解掉**版主**加的那把锁：
   * 版主叫停、楼主解开、再吵起来，处罚形同虚设。
   */
  unlock: boolean;
  move: boolean;
  /** 能不能折叠别人的回复 —— 判据和 moderateReply 服务端那条保持一致 */
  moderateReplies: boolean;
}

export const NO_CAPS: PostCaps = {
  moderateReplies: false,
  edit: false,
  deleteOwn: false,
  deleteAny: false,
  restore: false,
  feature: false,
  pin: false,
  lock: false,
  unlock: false,
  move: false,
};

export function postCapabilities(actor: Actor | null, post: PostRow): PostCaps {
  if (!actor) return NO_CAPS;

  const scope = { scopeType: "board" as const, scopeId: post.boardId };
  const isAuthor = actor.id === post.authorId;
  const deleted = post.status === "deleted";
  const canDeleteAny = can(actor, "forum.post.delete.any", scope).allowed;
  const lockActor = { userId: actor.id, canModerate: can(actor, "forum.post.lock", scope).allowed };

  if (deleted) {
    return {
      ...NO_CAPS,
      /*
       * 已删除的帖子只剩「恢复」一个入口。作者自删的可以自己恢复；
       * 管理员删的必须走申诉 —— 否则处罚形同虚设。
       */
      restore:
        canDeleteAny ||
        (isAuthor &&
          post.deletedBy === actor.id &&
          can(actor, "forum.post.delete.own", scope).allowed),
    };
  }

  return {
    edit: isAuthor
      ? can(actor, "forum.post.edit.own", scope).allowed
      : can(actor, "forum.post.edit.any", scope).allowed,
    deleteOwn: isAuthor && can(actor, "forum.post.delete.own", scope).allowed,
    // 版主删自己的帖子也走「自删」那条可撤销的路，别给同一个动作两个按钮
    deleteAny: !isAuthor && canDeleteAny,
    restore: false,
    feature: can(actor, "forum.post.feature", scope).allowed,
    pin: can(actor, "forum.post.pin", scope).allowed,
    /*
     * 锁 / 解锁都走 lock-rules —— 服务端 moderatePostCore 用的是
     * **同一组函数**。两处各判一遍的话，早晚会出现一个
     * 点了必然失败的按钮，或者更糟：一个不该出现却生效的按钮。
     */
    lock: canLock(lockActor, post),
    unlock: canUnlock(lockActor, post),
    move: can(actor, "forum.post.move", scope).allowed,
    /*
     * 能不能折叠**别人的回复**。
     *
     * 判据和 moderateReply 服务端那条一致：版主，或者楼主
     * （楼主可以管理自己帖子下的回复，但同样要留痕）。
     * 两处判据不一致的话，界面上会出现一个点了必然失败的按钮。
     */
    moderateReplies: isAuthor || canDeleteAny,
  };
}

export interface ManageResult {
  ok: boolean;
  error?: string;
  /** 有处罚记录的操作返回记录 id，申诉时对得上号 */
  actionId?: string;
}

const fail = (error: string): ManageResult => ({ ok: false, error });

export function recordModerationAction(input: {
  actorId: string;
  targetType: "post" | "reply" | "user";
  targetId: string;
  targetUserId?: string;
  action: string;
  reason: string;
  reportId?: string;
}) {
  return db
    .insert(moderationActions)
    .values({
      actorId: input.actorId,
      targetType: input.targetType,
      targetId: input.targetId,
      targetUserId: input.targetUserId,
      action: input.action as "delete",
      reason: input.reason,
      reportId: input.reportId,
    })
    .returning({ id: moderationActions.id })
    .get();
}

export const MODERATION_TITLE: Record<string, string> = {
  hide: "你的帖子被隐藏了",
  delete: "你的帖子被删除了",
  restore: "你的帖子已恢复",
  lock: "你的帖子被锁定了",
  unlock: "你的帖子已解锁",
  pin: "你的帖子被置顶了",
  unpin: "你的帖子取消了置顶",
  feature: "你的帖子被加精了",
  unfeature: "你的帖子取消了加精",
  collapse: "你的回复被折叠了",
  move: "你的帖子被移动了版块",
};

export type ModerateAction =
  | "hide"
  | "delete"
  | "restore"
  | "lock"
  | "unlock"
  | "pin"
  | "unpin"
  | "feature"
  | "unfeature";

const PERMISSION_FOR: Record<
  ModerateAction,
  "forum.post.delete.any" | "forum.post.lock" | "forum.post.pin" | "forum.post.feature"
> = {
  hide: "forum.post.delete.any",
  delete: "forum.post.delete.any",
  restore: "forum.post.delete.any",
  lock: "forum.post.lock",
  unlock: "forum.post.lock",
  pin: "forum.post.pin",
  unpin: "forum.post.pin",
  feature: "forum.post.feature",
  unfeature: "forum.post.feature",
};

export function moderatePostCore(
  actor: Actor | null,
  input: { postId: string; action: ModerateAction; reason: string },
): ManageResult {
  const reason = input.reason.trim();
  if (!reason) return fail("必须填写理由");

  const post = db.select().from(posts).where(eq(posts.id, input.postId)).get();
  if (!post) return fail("帖子不存在");

  if (!actor) return fail("请先登录");

  const scope = { scopeType: "board" as const, scopeId: post.boardId };

  /*
   * 锁 / 解锁**不只看权限**，还看是谁锁的 —— 见 lock-rules。
   *
   * 楼主可以锁自己的帖子（FORUM.md 4.3），但只解得开自己加的那把：
   * 否则版主叫停、楼主解开、再吵起来，处罚形同虚设。
   *
   * 界面那边（postCapabilities）调的是同一组函数。
   */
  if (input.action === "lock" || input.action === "unlock") {
    const lockActor = { userId: actor.id, canModerate: can(actor, "forum.post.lock", scope).allowed };
    const allowed =
      input.action === "lock" ? canLock(lockActor, post) : canUnlock(lockActor, post);
    if (!allowed) {
      return fail(
        input.action === "lock"
          ? "只有楼主和版主能锁帖"
          : "这把锁是版主加的，得由版主解 —— 有异议走申诉",
      );
    }
  } else {
    const verdict = can(actor, PERMISSION_FOR[input.action], scope);
    if (!verdict.allowed) return fail(verdict.reason);
  }

  const now = Date.now();
  const patch: Partial<typeof posts.$inferInsert> = {};
  switch (input.action) {
    case "hide":
      patch.status = "hidden";
      break;
    case "delete":
      patch.status = "deleted";
      patch.deletedAt = now;
      patch.deletedBy = actor.id;
      patch.deleteReason = reason;
      break;
    case "restore":
      patch.status = "published";
      patch.deletedAt = null;
      patch.deletedBy = null;
      patch.deleteReason = null;
      break;
    case "lock": {
      // 理由要显示给看帖的人，所以在这里再规范一次（去掉多余空白、限长）
      const shaped = checkLockReason(reason);
      if (!shaped.ok) return fail(shaped.message);
      patch.status = "locked";
      patch.lockedBy = actor.id;
      patch.lockReason = shaped.reason;
      break;
    }
    case "unlock":
      patch.status = "published";
      // 解开就把痕迹清掉 —— 留着的话下次谁锁的就说不清了
      patch.lockedBy = null;
      patch.lockReason = null;
      break;
    case "pin":
      patch.pinned = true;
      break;
    case "unpin":
      patch.pinned = false;
      break;
    case "feature":
      patch.featured = true;
      patch.featuredBy = actor.id;
      patch.featuredAt = now;
      break;
    case "unfeature":
      patch.featured = false;
      break;
  }

  db.update(posts).set(patch).where(eq(posts.id, post.id)).run();

  // 状态变了就重算版块计数：删除/隐藏/恢复都会改变「版块里有几篇帖子」。
  // 以前只加不减，删 10 篇之后版块列表还挂着虚高的数字
  if (patch.status !== undefined) recountBoardPosts(post.boardId);

  // 删除或隐藏后要从检索索引里摘掉，否则还能被搜到标题；恢复时要放回去
  if (input.action === "delete" || input.action === "hide") removeFromIndex(post.id);
  if (input.action === "restore") indexPost(post.id, post.title, post.content);

  const action = recordModerationAction({
    actorId: actor.id,
    targetType: "post",
    targetId: post.id,
    targetUserId: post.authorId,
    action: input.action,
    reason,
  });

  // 通知作者。悄悄删帖是最招怨的做法
  if (post.authorId !== actor.id) {
    notify({
      userId: post.authorId,
      type: "moderation",
      groupKey: `mod:${post.id}:${input.action}`,
      title: MODERATION_TITLE[input.action],
      body: `「${post.title}」· ${reason}`,
      link: `/forum/p/${post.id}`,
      actorId: actor.id,
      refType: "post",
      refId: post.id,
    });
  }

  audit({ actorId: actor.id }, {
    action: `forum.post.${input.action}`,
    targetType: "post",
    targetId: post.id,
    targetLabel: post.title,
    before: { status: post.status, pinned: post.pinned, featured: post.featured },
    after: patch,
    reason,
  });

  return { ok: true, actionId: action.id };
}

/**
 * 移动版块。
 *
 * 可见性必须按目标版块的封顶**重新收口**：把 public 帖移进「仅成员」的
 * 版块而不收口，等于给了一条把内部内容搬到公开区的旁路 —— 反过来
 * 同理。群聊转帖（visibilityLocked）的可见性锁死不动，
 * 移到哪都还是原群可见。
 */
export function movePostCore(
  actor: Actor | null,
  input: { postId: string; toBoardId: string; reason?: string },
): ManageResult {
  const post = db.select().from(posts).where(eq(posts.id, input.postId)).get();
  if (!post) return fail("帖子不存在");

  if (!actor) return fail("请先登录");
  // scope 是**源**版块：版主只能把自己版块的帖子移走，
  // 不能把别人版块的帖子搬进自己的地盘
  const verdict = can(actor, "forum.post.move", {
    scopeType: "board",
    scopeId: post.boardId,
  });
  if (!verdict.allowed) return fail(verdict.reason);

  const target = db.select().from(boards).where(eq(boards.id, input.toBoardId)).get();
  if (!target || target.deletedAt) return fail("目标版块不存在");
  if (target.locked) return fail("目标版块已锁定");
  if (target.id === post.boardId) return fail("帖子已经在这个版块");

  const reason = input.reason?.trim() || "版块调整";

  const patch: Partial<typeof posts.$inferInsert> = {
    boardId: target.id,
    updatedAt: Date.now(),
  };
  if (!post.visibilityLocked) {
    patch.visibility = capVisibility(post.visibility, target.maxVisibility);
  }

  db.update(posts).set(patch).where(eq(posts.id, post.id)).run();

  // 两边的计数都要重算 —— 只算一边就会出现「总数不变但两边都不对」
  recountBoardPosts(post.boardId);
  recountBoardPosts(target.id);

  const action = recordModerationAction({
    actorId: actor.id,
    targetType: "post",
    targetId: post.id,
    targetUserId: post.authorId,
    action: "move",
    reason,
  });

  if (post.authorId !== actor.id) {
    notify({
      userId: post.authorId,
      type: "moderation",
      groupKey: `mod:${post.id}:move`,
      title: MODERATION_TITLE.move,
      body: `「${post.title}」移到了「${target.name}」· ${reason}`,
      link: `/forum/p/${post.id}`,
      actorId: actor.id,
      refType: "post",
      refId: post.id,
    });
  }

  audit({ actorId: actor.id }, {
    action: "forum.post.move",
    targetType: "post",
    targetId: post.id,
    targetLabel: post.title,
    before: { boardId: post.boardId, visibility: post.visibility },
    after: { boardId: target.id, visibility: patch.visibility ?? post.visibility },
    reason,
  });

  return { ok: true, actionId: action.id };
}

/**
 * 作者自删 / 自己恢复。
 *
 * 软删 + 撤销窗口，不弹确认框。权限照样走 can() ——
 * 「是作者」不等于「可以删」：被封禁的账号连自己的帖子也动不了。
 */
export function deleteOwnPostCore(actor: Actor | null, postId: string): ManageResult {
  if (!actor) return fail("请先登录");

  const post = db.select().from(posts).where(eq(posts.id, postId)).get();
  if (!post) return fail("帖子不存在");
  if (post.authorId !== actor.id) return fail("只能删自己的帖子");
  if (post.status === "deleted") return fail("帖子已经删除了");

  const verdict = can(actor, "forum.post.delete.own", {
    scopeType: "board",
    scopeId: post.boardId,
  });
  if (!verdict.allowed) return fail(verdict.reason);

  db.update(posts)
    .set({ status: "deleted", deletedAt: Date.now(), deletedBy: actor.id, deleteReason: "作者删除" })
    .where(eq(posts.id, postId))
    .run();

  // 自删也要从索引摘掉并重算版块 —— 之前漏了这两步：
  // 删掉的帖子还能被搜到标题，版块计数也一直虚高
  removeFromIndex(postId);
  recountBoardPosts(post.boardId);

  audit({ actorId: actor.id }, {
    action: "forum.post.delete.own",
    targetType: "post",
    targetId: postId,
    targetLabel: post.title,
    reason: "作者删除",
  });

  return { ok: true };
}

export function restoreOwnPostCore(actor: Actor | null, postId: string): ManageResult {
  if (!actor) return fail("请先登录");

  const post = db.select().from(posts).where(eq(posts.id, postId)).get();
  if (!post) return fail("帖子不存在");
  if (post.authorId !== actor.id) return fail("只能恢复自己的帖子");
  if (post.status !== "deleted") return { ok: true };
  // 管理员删的不能被作者自己撤销回来 —— 否则处罚形同虚设
  if (post.deletedBy && post.deletedBy !== actor.id) {
    return fail("这篇是被管理员处理的，请走申诉");
  }

  const verdict = can(actor, "forum.post.delete.own", {
    scopeType: "board",
    scopeId: post.boardId,
  });
  if (!verdict.allowed) return fail(verdict.reason);

  db.update(posts)
    .set({ status: "published", deletedAt: null, deletedBy: null, deleteReason: null })
    .where(eq(posts.id, postId))
    .run();

  indexPost(postId, post.title, post.content);
  recountBoardPosts(post.boardId);

  audit({ actorId: actor.id }, {
    action: "forum.post.delete.own",
    targetType: "post",
    targetId: postId,
    targetLabel: post.title,
    reason: "作者撤销删除",
  });

  return { ok: true };
}
