"use server";

import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { requireAdmin, requireWritableAdmin } from "@/lib/admin/guard";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { inviteUses, invites } from "@/lib/db/schema";
import { findByCode, isAlreadyInvited } from "@/lib/invites/queries";
import { checkCreate, checkRedeem, generateCode, normalizeCode } from "@/lib/invites/rules";
import { settleAllPending } from "@/lib/invites/settle";

/**
 * 邀请的写操作。
 *
 * 现阶段只有群成员能登录，所以「用码注册」那条路还没接上 ——
 * 但码的生成、撤销、使用记录与奖励结算全部就位，
 * 开关一开就能用。
 *
 * `redeemInvite` 目前只做**记账**（写 invite_uses 和 users.invitedBy），
 * 不负责创建账号 —— 账号创建仍然走绑定流程。
 * 这样即使外部注册没开，管理员手动为某人补记邀请关系也是可行的。
 */

export interface InviteResult {
  ok: boolean;
  error?: string;
  code?: string;
  note?: string;
}

const fail = (error: string): InviteResult => ({ ok: false, error });

export async function createInvite(input: {
  maxUses: number | null;
  expiresInDays: number | null;
  note: string;
  grantKind?: "member" | "external";
}): Promise<InviteResult> {
  const admin = await requireWritableAdmin("invite.manage");

  const check = checkCreate(input);
  if (!check.ok) return fail(check.error!);

  // 撞码的概率极低，但撞上一次就是有人拿到别人的码，所以还是重试
  let code = generateCode();
  for (let i = 0; i < 10; i++) {
    if (!db.select().from(invites).where(eq(invites.code, code)).get()) break;
    code = generateCode();
  }

  db.insert(invites)
    .values({
      code,
      createdBy: admin.user.id,
      note: input.note.trim() || null,
      maxUses: input.maxUses,
      expiresAt:
        input.expiresInDays === null ? null : Date.now() + input.expiresInDays * 86_400_000,
      grantKind: input.grantKind ?? "external",
    })
    .run();

  audit({ actorId: admin.user.id }, {
    action: "invite.manage",
    targetType: "invite",
    targetId: code,
    after: { maxUses: input.maxUses, expiresInDays: input.expiresInDays },
    reason: input.note,
  });

  revalidatePath("/admin/invites");
  return { ok: true, code };
}

export async function revokeInvite(input: {
  id: string;
  reason: string;
}): Promise<InviteResult> {
  const admin = await requireWritableAdmin("invite.manage");
  if (!input.reason.trim()) return fail("必须填写理由");

  const row = db.select().from(invites).where(eq(invites.id, input.id)).get();
  if (!row) return fail("邀请码不存在");
  if (row.revokedAt !== null) return fail("已经撤销过了");

  db.update(invites)
    .set({ revokedAt: Date.now(), revokedBy: admin.user.id, revokeReason: input.reason.trim() })
    .where(eq(invites.id, input.id))
    .run();

  audit({ actorId: admin.user.id }, {
    action: "invite.manage",
    targetType: "invite",
    targetId: row.code,
    after: { revoked: true },
    reason: input.reason,
  });

  revalidatePath("/admin/invites");
  return {
    ok: true,
    // 说清楚撤销不影响已经进来的人 —— 否则管理员会以为撤销能把人踢出去
    note: "已撤销。已经用这个码进来的人不受影响 —— 要处理他们请单独封禁。",
  };
}

/**
 * 记一次邀请关系。
 *
 * 只写关系，不发奖励 —— 奖励等被邀请人完成首次打卡时才结算，
 * 见 invites/settle.ts。注册即给的话，拉一堆僵尸号就能刷分。
 */
export async function redeemInvite(input: {
  code: string;
  userId: string;
}): Promise<InviteResult> {
  const admin = await requireWritableAdmin("invite.manage");

  const invite = findByCode(input.code);
  const check = checkRedeem({
    invite,
    userId: input.userId,
    alreadyInvited: isAlreadyInvited(input.userId),
    now: Date.now(),
  });
  if (!check.ok) return fail(check.error!);

  db.transaction((tx) => {
    tx.insert(inviteUses)
      .values({
        inviteId: invite!.id,
        inviterId: invite!.createdBy,
        invitedUserId: input.userId,
      })
      .run();

    tx.update(invites)
      .set({ usedCount: sql`${invites.usedCount} + 1` })
      .where(eq(invites.id, invite!.id))
      .run();

    tx.run(
      sql`UPDATE users SET invited_by = ${invite!.createdBy} WHERE id = ${input.userId} AND invited_by IS NULL`,
    );
  });

  audit({ actorId: admin.user.id }, {
    action: "invite.manage",
    targetType: "user",
    targetId: input.userId,
    after: { invitedBy: invite!.createdBy, code: normalizeCode(input.code) },
  });

  revalidatePath("/admin/invites");
  return {
    ok: true,
    note: "已记录邀请关系。奖励要等这个人完成首次打卡才发 —— 注册即给的话，拉僵尸号就能刷分。",
  };
}

/**
 * 手动跑一次结算。
 *
 * 结算挂在打卡流程上，但流程可能因为改代码或异常漏掉 ——
 * 有一个能兜底重跑的入口，比祈祷流程永不出错可靠。
 */
export async function settleInvites(): Promise<InviteResult> {
  const admin = await requireAdmin("invite.manage");
  const result = settleAllPending();

  audit({ actorId: admin.user.id }, {
    action: "invite.manage",
    targetType: "invite",
    targetId: "*",
    after: result,
  });

  revalidatePath("/admin/invites");
  return {
    ok: true,
    note: `补发 ${result.settled} 笔，回滚 ${result.reverted} 笔。`,
  };
}
