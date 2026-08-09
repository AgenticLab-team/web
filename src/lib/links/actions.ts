"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { requireWritableAdmin } from "@/lib/admin/guard";
import { audit } from "@/lib/audit";
import { getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { linkSaves, links } from "@/lib/db/schema";
import { canSeeLink } from "@/lib/links/queries";

export interface LinkActionResult {
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
