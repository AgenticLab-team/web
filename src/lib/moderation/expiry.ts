import "server-only";

import { and, desc, eq, isNotNull, isNull, lte } from "drizzle-orm";

import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { moderationActions, users } from "@/lib/db/schema";
import { notify } from "@/lib/forum/notify";

import { isActive, statusAfterExpiry } from "./duration-rules";

/**
 * 到期自动解封。
 *
 * ─────────────────────────────────────────
 * 没有这一步的话，「7 天」只是一句安慰话
 * ─────────────────────────────────────────
 *
 * 写一个 `expires_at` 而没有人去扫它，被封的人到了第八天
 * 仍然进不来 —— 而界面上写着「已经到期」。那比不给期限更糟：
 * 不给期限至少是诚实的。
 */

export interface ExpiryResult {
  unbanned: number;
  /** 已经到期、但当事人现在是别的状态（比如自己退群了）—— 不动他 */
  skipped: number;
}

export function releaseExpiredBans(now = Date.now()): ExpiryResult {
  const result: ExpiryResult = { unbanned: 0, skipped: 0 };

  /*
   * 到期、没撤销、而且是封禁类的那些。
   *
   * 撤销过的不算 —— 一条被申诉撤掉的封禁不该在到期时再「解」一次，
   * 那会写出一条莫名其妙的解封记录。
   */
  const due = db
    .select()
    .from(moderationActions)
    .where(
      and(
        isNotNull(moderationActions.expiresAt),
        lte(moderationActions.expiresAt, now),
        isNull(moderationActions.revertedAt),
      ),
    )
    .orderBy(desc(moderationActions.createdAt))
    .all()
    .filter((r) => r.action === "ban" || r.action === "suspend");

  for (const record of due) {
    const userId = record.targetUserId;
    if (!userId) continue;

    const user = db.select().from(users).where(eq(users.id, userId)).get();
    if (!user) continue;

    /*
     * 这个人身上还有别的、**还没到期**的处罚吗。
     *
     * 有的话不能解 —— 封 7 天之后又被封 30 天，
     * 第 7 天到了就放人的话，第二条处罚等于没发生。
     */
    const stillPunished = db
      .select()
      .from(moderationActions)
      .where(and(eq(moderationActions.targetUserId, userId), isNull(moderationActions.revertedAt)))
      .all()
      .some(
        (r) =>
          r.id !== record.id &&
          (r.action === "ban" || r.action === "suspend") &&
          isActive({ expiresAt: r.expiresAt, revertedAt: r.revertedAt }, now),
      );
    if (stillPunished) continue;

    const next = statusAfterExpiry(user.status);
    if (next === null) {
      // 他现在不是被封的状态（自己退群了 / 账号被清理了）—— 不动
      result.skipped++;
      continue;
    }

    db.update(users).set({ status: next, updatedAt: now }).where(eq(users.id, userId)).run();

    db.insert(moderationActions)
      .values({
        actorId: "system",
        targetType: "user",
        targetId: userId,
        targetUserId: userId,
        action: "unban",
        reason: "处罚到期，自动解除",
      })
      .run();

    /*
     * 告诉当事人。
     *
     * 不说的话他不知道自己什么时候能回来 —— 而多数人不会每天
     * 回来试一次。这一类通知是关不掉的（moderation 在 ALWAYS_ON 里）。
     */
    notify({
      userId,
      type: "moderation",
      groupKey: `unban:${userId}`,
      title: "处罚已经到期，账号恢复正常",
      body: record.reason,
      link: "/me/moderation",
    });

    audit(
      { actorId: "system" },
      {
        action: "user.unban.auto",
        targetType: "user",
        targetId: userId,
        before: { status: user.status },
        after: { status: next },
        reason: `处罚到期（原因：${record.reason}）`,
      },
    );

    result.unbanned++;
  }

  return result;
}

