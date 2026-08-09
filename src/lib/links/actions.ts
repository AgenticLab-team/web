"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { requireWritableAdmin } from "@/lib/admin/guard";
import { audit } from "@/lib/audit";
import { getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { linkSaves, linkVotes, links } from "@/lib/db/schema";
import { canSeeLink, recountVotes } from "@/lib/links/queries";

export interface LinkActionResult {
  voted?: boolean;
  voteCount?: number;
  ok: boolean;
  error?: string;
  saved?: boolean;
}

/**
 * 收藏 / 取消收藏。
 *
 * 收藏前判一次可见性 —— 否则任何人拿一个猜到的 id 就能把别的群的链接
 * 收进自己的列表，然后在收藏页里看到它。
 * **收藏不能成为绕过可见性的后门。**
 */
export async function toggleSaveLink(linkId: string): Promise<LinkActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "请先登录" };
  if (!canSeeLink(user, linkId)) return { ok: false, error: "这条链接不在你可见的范围里" };

  const existing = db
    .select()
    .from(linkSaves)
    .where(and(eq(linkSaves.userId, user.id), eq(linkSaves.linkId, linkId)))
    .get();

  if (existing) {
    db.delete(linkSaves).where(eq(linkSaves.id, existing.id)).run();
    revalidatePath("/links");
    return { ok: true, saved: false };
  }

  db.insert(linkSaves).values({ userId: user.id, linkId }).onConflictDoNothing().run();
  revalidatePath("/links");
  return { ok: true, saved: true };
}

/**
 * 给一条资源点赞 / 取消点赞。
 *
 * ─────────────────────────────────────────
 * 计数从明细重算，不做 +1
 * ─────────────────────────────────────────
 *
 * 这个项目对冗余计数有一条硬规矩。加减法在并发、重试、
 * 用户连点之后会慢慢和明细对不上,而对不上的表现是「数字有点怪」——
 * 没有人会为一个有点怪的数字去查明细。
 *
 * 重算一次是一条 `count(*)`，在这个量级上没有任何代价。
 */
export async function toggleVoteLink(linkId: string): Promise<LinkActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "请先登录" };
  // 点赞是公开信号，但**能不能点仍然按可见性收口** —— 看不到的东西不该能点
  if (!canSeeLink(user, linkId)) return { ok: false, error: "这条链接不在你可见的范围里" };

  const existing = db
    .select()
    .from(linkVotes)
    .where(and(eq(linkVotes.userId, user.id), eq(linkVotes.linkId, linkId)))
    .get();

  if (existing) {
    db.delete(linkVotes).where(eq(linkVotes.id, existing.id)).run();
  } else {
    db.insert(linkVotes).values({ userId: user.id, linkId }).onConflictDoNothing().run();
  }

  const count = recountVotes(linkId);

  revalidatePath("/links");
  return { ok: true, voted: !existing, voteCount: count };
}

/** 管理员隐藏一条链接：广告、失效、不宜出现在列表里的 */
export async function hideLink(linkId: string, reason: string): Promise<LinkActionResult> {
  const admin = await requireWritableAdmin("forum.post.delete.any");

  const before = db.select().from(links).where(eq(links.id, linkId)).get();
  if (!before) return { ok: false, error: "链接不存在" };

  db.update(links)
    .set({ hidden: !before.hidden, hiddenReason: before.hidden ? null : reason || "未说明" })
    .where(eq(links.id, linkId))
    .run();

  audit(
    { actorId: admin.user.id },
    {
      action: "forum.post.delete.any",
      targetType: "link",
      targetId: linkId,
      targetLabel: before.url,
      before: { hidden: before.hidden },
      after: { hidden: !before.hidden },
      reason,
    },
  );

  revalidatePath("/links");
  revalidatePath("/admin/links");
  return { ok: true };
}
