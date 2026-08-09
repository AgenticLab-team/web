"use server";

import { eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { requireWritableAdmin } from "@/lib/admin/guard";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { moderationActions, posts } from "@/lib/db/schema";
import { recountBoardPosts } from "@/lib/forum/board-stats";
import { notify } from "@/lib/forum/notify";
import { removeFromIndex } from "@/lib/forum/search";
import {
  actionLabel,
  checkBulk,
  isDestructive,
  summarize,
  type BulkAction,
  type BulkOutcome,
  type BulkReport,
} from "@/lib/moderation/bulk-rules";

/**
 * 帖子批量操作。
 *
 * 三条不能省的：
 *
 * ① **每一条都独立留处罚记录。** 只记一条汇总日志的话，
 *   用户档案上看不到自己那条，申诉时无从查起 ——
 *   而「我被删了帖但不知道为什么」正是最招怨的情形。
 *
 * ② **每一位作者都要收到通知。** 悄悄删帖是最招怨的做法：
 *   作者以为自己发出去了，别人却看不到，几天后才发现。
 *
 * ③ **部分失败要点名。** 「成功 47 条」而剩下 3 条静默消失，
 *   那 3 条往往正是有问题的那几条。
 */

export interface BulkResult {
  ok: boolean;
  error?: string;
  report?: BulkReport;
}

export async function bulkModeratePosts(input: {
  ids: string[];
  action: BulkAction;
  reason: string;
}): Promise<BulkResult> {
  const admin = await requireWritableAdmin("forum.post.delete.any");

  const check = checkBulk({ ids: input.ids, action: input.action, reason: input.reason });
  if (!check.ok) return { ok: false, error: check.error };

  const reason = input.reason.trim();
  const rows = db.select().from(posts).where(inArray(posts.id, input.ids)).all();
  const found = new Map(rows.map((r) => [r.id, r]));

  const outcomes: BulkOutcome[] = [];
  const touchedBoards = new Set<string>();

  for (const id of input.ids) {
    const post = found.get(id);
    if (!post) {
      outcomes.push({ id, ok: false, error: "帖子不存在" });
      continue;
    }

    // 自己的帖子也能处理，但要留痕 —— 这里不拦，只是记录里作者与操作者相同
    const patch = patchFor(input.action, admin.user.id, reason);
    if (!patch) {
      outcomes.push({ id, ok: false, error: "不支持的操作" });
      continue;
    }

    try {
      db.transaction((tx) => {
        tx.update(posts).set(patch).where(eq(posts.id, id)).run();

        // ① 逐条留处罚记录，不是一条汇总
        tx.insert(moderationActions)
          .values({
            actorId: admin.user.id,
            targetType: "post",
            targetId: id,
            targetUserId: post.authorId,
            action: input.action as "delete",
            reason,
          })
          .run();
      });

      if (input.action === "delete" || input.action === "hide") removeFromIndex(id);
      if (patch.status !== undefined) touchedBoards.add(post.boardId);

      // ② 通知作者。自己处理自己的不用通知
      if (post.authorId !== admin.user.id) {
        notify({
          userId: post.authorId,
          type: "moderation",
          groupKey: `mod:${id}:${input.action}`,
          title: `你的帖子被${actionLabel(input.action)}了`,
          body: `「${post.title}」· ${reason}`,
          link: `/forum/p/${id}`,
          actorId: admin.user.id,
        });
      }

      outcomes.push({ id, ok: true });
    } catch (error) {
      // 单条失败不能让整批停下，但必须被点名
      outcomes.push({ id, ok: false, error: error instanceof Error ? error.message : "写入失败" });
    }
  }

  for (const boardId of touchedBoards) recountBoardPosts(boardId);

  const report = summarize(outcomes, actionLabel(input.action));

  audit({ actorId: admin.user.id }, {
    action: "forum.post.delete.any",
    targetType: "post",
    targetId: input.ids[0],
    targetLabel: `批量${actionLabel(input.action)} ${report.succeeded} 条`,
    after: {
      bulk: input.action,
      requested: input.ids.length,
      succeeded: report.succeeded,
      failed: report.failed.map((f) => f.id),
      // 破坏性操作把 id 全记下来，事后要能逐条回滚
      ids: isDestructive(input.action) ? input.ids : undefined,
    },
    reason,
  });

  revalidatePath("/admin/posts");
  revalidatePath("/forum");

  return { ok: report.succeeded > 0, error: report.succeeded === 0 ? report.message : undefined, report };
}

function patchFor(
  action: BulkAction,
  actorId: string,
  reason: string,
): Partial<typeof posts.$inferInsert> | null {
  const now = Date.now();
  switch (action) {
    case "hide":
      return { status: "hidden", updatedAt: now };
    case "delete":
      return { status: "deleted", deletedAt: now, deletedBy: actorId, deleteReason: reason, updatedAt: now };
    case "restore":
      return { status: "published", deletedAt: null, deletedBy: null, deleteReason: null, updatedAt: now };
    case "lock":
      return { status: "locked", updatedAt: now };
    case "unlock":
      return { status: "published", updatedAt: now };
    case "feature":
      return { featured: true, featuredBy: actorId, featuredAt: now, updatedAt: now };
    case "unfeature":
      return { featured: false, updatedAt: now };
    default:
      return null;
  }
}
