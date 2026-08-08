"use server";

import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/lib/admin/guard";
import { audit } from "@/lib/audit";
import {
  getBroadcast,
  msSinceLastSend,
  sendableGroups,
  sentToday,
} from "@/lib/broadcast/queries";
import {
  checkApprove,
  checkDraft,
  checkRevoke,
  checkSend,
  contentHash,
} from "@/lib/broadcast/rules";
import { db } from "@/lib/db";
import { broadcastDeliveries, broadcasts } from "@/lib/db/schema";
import { nekobot } from "@/lib/nekobot/client";

/**
 * 群发的写操作。
 *
 * 流程：起草 → 冻结内容提交复核 → 另一个人复核 → 排队 → 逐群发送。
 *
 * **发送本身不在这里做。** 十二个群逐条发、每条之间还要留间隔，
 * 一次群发要跑一两分钟 —— 放在 web 请求里，超时会把它拦腰截断，
 * 而那时一部分群已经收到了。真正的发送在 broadcast/sender.ts，
 * 由后台进程取走执行。
 */

export interface BroadcastResult {
  ok: boolean;
  error?: string;
  id?: string;
  note?: string;
}

const fail = (error: string): BroadcastResult => ({ ok: false, error });

export async function saveDraft(input: {
  id?: string;
  channel: "site" | "wechat";
  title?: string;
  content: string;
  display?: "banner" | "modal" | "inbox";
  targetConvIds?: string[];
  expiresAt?: number;
}): Promise<BroadcastResult> {
  const admin = await requireAdmin(
    input.channel === "wechat" ? "broadcast.wechat" : "announce.site",
  );

  const available = sendableGroups().map((g) => g.convId);
  const check = checkDraft({
    channel: input.channel,
    content: input.content,
    targetConvIds: input.targetConvIds ?? [],
    availableConvIds: available,
  });
  if (!check.ok) return fail(check.error!);

  const values = {
    channel: input.channel,
    title: input.title?.trim() || null,
    content: input.content.trim(),
    display: input.display ?? null,
    targetConvIds: input.targetConvIds ?? null,
    expiresAt: input.expiresAt ?? null,
    // 改动之后要重新走复核 —— 冻结的哈希作废
    contentHash: null,
    status: "draft" as const,
  };

  if (input.id) {
    const existing = getBroadcast(input.id);
    if (!existing) return fail("找不到这条群发");
    if (existing.status !== "draft" && existing.status !== "rejected") {
      return fail("只有草稿和被驳回的能改");
    }
    db.update(broadcasts).set(values).where(eq(broadcasts.id, input.id)).run();
    return { ok: true, id: input.id };
  }

  const row = db
    .insert(broadcasts)
    .values({ ...values, createdBy: admin.user.id })
    .returning({ id: broadcasts.id })
    .get();

  revalidatePath("/admin/broadcast");
  return { ok: true, id: row.id };
}

/** 提交复核。**这一刻内容被冻结** —— 之后再改，复核和发送都会被拒 */
export async function submitForReview(input: { id: string }): Promise<BroadcastResult> {
  const admin = await requireAdmin("announce.site");

  const row = getBroadcast(input.id);
  if (!row) return fail("找不到这条群发");
  if (row.status !== "draft" && row.status !== "rejected") return fail("这条不是草稿");

  db.update(broadcasts)
    .set({
      status: "pending",
      contentHash: contentHash(row.content),
      submittedAt: Date.now(),
    })
    .where(eq(broadcasts.id, input.id))
    .run();

  audit({ actorId: admin.user.id }, {
    action: "announce.site",
    targetType: "broadcast",
    targetId: input.id,
    after: { submitted: true, channel: row.channel },
  });

  revalidatePath("/admin/broadcast");
  return { ok: true, note: "已提交复核。内容已冻结 —— 再改的话要重新提交。" };
}

export async function approveBroadcast(input: {
  id: string;
  note: string;
}): Promise<BroadcastResult> {
  const admin = await requireAdmin("broadcast.approve");

  const row = getBroadcast(input.id);
  if (!row) return fail("找不到这条群发");

  const check = checkApprove({
    actorId: admin.user.id,
    createdBy: row.createdBy,
    status: row.status,
    frozenHash: row.contentHash,
    currentHash: contentHash(row.content),
    note: input.note,
  });
  if (!check.ok) return fail(check.error!);

  db.update(broadcasts)
    .set({
      status: "approved",
      approvedBy: admin.user.id,
      approvedAt: Date.now(),
      approveNote: input.note.trim(),
    })
    .where(eq(broadcasts.id, input.id))
    .run();

  audit({ actorId: admin.user.id }, {
    action: "broadcast.approve",
    targetType: "broadcast",
    targetId: input.id,
    targetLabel: row.title ?? row.content.slice(0, 40),
    after: { approved: true, channel: row.channel },
    reason: input.note,
  });

  revalidatePath("/admin/broadcast");
  return { ok: true };
}

export async function rejectBroadcast(input: {
  id: string;
  note: string;
}): Promise<BroadcastResult> {
  const admin = await requireAdmin("broadcast.approve");
  if (!input.note.trim()) return fail("驳回也要写明原因");

  const row = getBroadcast(input.id);
  if (!row) return fail("找不到这条群发");
  if (row.status !== "pending") return fail("这条不在待复核状态");
  if (admin.user.id === row.createdBy) return fail("不能处理自己起草的群发");

  db.update(broadcasts)
    .set({ status: "rejected", approveNote: input.note.trim(), approvedBy: admin.user.id })
    .where(eq(broadcasts.id, input.id))
    .run();

  audit({ actorId: admin.user.id }, {
    action: "broadcast.approve",
    targetType: "broadcast",
    targetId: input.id,
    after: { rejected: true },
    reason: input.note,
  });

  revalidatePath("/admin/broadcast");
  return { ok: true };
}

/**
 * 排队发送。
 *
 * 站内公告直接标为已发送（它只是数据库里的一行，没有外部副作用）。
 * 微信群发则进入 sending 状态等后台进程取走 ——
 * 所有闸门在这里就检查完，不是等到真发的时候。
 */
export async function queueSend(input: { id: string }): Promise<BroadcastResult> {
  const admin = await requireAdmin(
    (getBroadcast(input.id)?.channel ?? "site") === "wechat"
      ? "broadcast.wechat"
      : "announce.site",
  );

  const row = getBroadcast(input.id);
  if (!row) return fail("找不到这条群发");

  if (row.channel === "site") {
    if (row.status !== "approved") return fail("还没通过复核");
    db.update(broadcasts)
      .set({ status: "sent", startedAt: Date.now(), finishedAt: Date.now(), sentCount: 1 })
      .where(eq(broadcasts.id, input.id))
      .run();

    audit({ actorId: admin.user.id }, {
      action: "announce.site",
      targetType: "broadcast",
      targetId: input.id,
      after: { published: true },
    });

    revalidatePath("/admin/broadcast");
    revalidatePath("/");
    return { ok: true, note: "站内公告已发布。" };
  }

  const targets =
    (Array.isArray(row.targetConvIds) ? (row.targetConvIds as string[]) : null) ??
    sendableGroups().map((g) => g.convId);

  let quota;
  try {
    quota = await nekobot.sendQuota();
  } catch (error) {
    /*
     * 查不到额度就**不发**。
     * 「查不到就当没限制」是最危险的默认值 —— 那正是撞上风控的姿势。
     */
    return fail(
      `查不到上游发送额度，不能发：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const check = checkSend({
    status: row.status,
    frozenHash: row.contentHash,
    currentHash: contentHash(row.content),
    approvedBy: row.approvedBy,
    msSinceLastSend: msSinceLastSend(),
    sentToday: sentToday(),
    quota: {
      perMinute: quota.per_minute,
      perHour: quota.per_hour,
    },
    targetCount: targets.length,
  });
  if (!check.ok) return fail(check.error!);

  const names = new Map(sendableGroups().map((g) => [g.convId, g.name]));

  db.transaction((tx) => {
    tx.update(broadcasts)
      .set({ status: "sending", startedAt: Date.now() })
      .where(eq(broadcasts.id, input.id))
      .run();

    // 逐群一条待发记录。汇总成一条的话，没发出去的那几个群永远没人知道
    for (const convId of targets) {
      tx.insert(broadcastDeliveries)
        .values({ broadcastId: input.id, convId, convName: names.get(convId) ?? null })
        .run();
    }
  });

  audit({ actorId: admin.user.id }, {
    action: "broadcast.wechat",
    targetType: "broadcast",
    targetId: input.id,
    targetLabel: row.content.slice(0, 40),
    after: { queued: true, targets: targets.length, approvedBy: row.approvedBy },
    reason: row.approveNote ?? undefined,
  });

  revalidatePath("/admin/broadcast");
  return {
    ok: true,
    note: `已排队，将逐个群发送 ${targets.length} 条并留出间隔 —— 一秒连发是最典型的风控触发姿势。`,
  };
}

export async function cancelBroadcast(input: { id: string }): Promise<BroadcastResult> {
  const admin = await requireAdmin("announce.site");
  const row = getBroadcast(input.id);
  if (!row) return fail("找不到这条群发");
  if (row.status === "sent" || row.status === "sending") {
    return fail("已经开始发了，取消不了 —— 只能逐条撤回");
  }

  db.update(broadcasts).set({ status: "canceled" }).where(eq(broadcasts.id, input.id)).run();

  audit({ actorId: admin.user.id }, {
    action: "announce.site",
    targetType: "broadcast",
    targetId: input.id,
    after: { canceled: true },
  });

  revalidatePath("/admin/broadcast");
  return { ok: true };
}

/** 撤回某一个群里的那条。窗口很短，失败是常态 */
export async function revokeDelivery(input: { deliveryId: string }): Promise<BroadcastResult> {
  const admin = await requireAdmin("broadcast.wechat");

  const row = db
    .select()
    .from(broadcastDeliveries)
    .where(eq(broadcastDeliveries.id, input.deliveryId))
    .get();
  if (!row) return fail("找不到这条投递记录");

  const check = checkRevoke({
    status: row.status,
    msgSvrId: row.msgSvrId,
    sentAt: row.sentAt,
    now: Date.now(),
  });
  if (!check.ok) return fail(check.error!);

  try {
    await nekobot.revoke(row.convId, row.msgSvrId!);
  } catch (error) {
    return fail(`撤回失败：${error instanceof Error ? error.message : String(error)}`);
  }

  db.update(broadcastDeliveries)
    .set({ status: "revoked", revokedAt: Date.now() })
    .where(eq(broadcastDeliveries.id, input.deliveryId))
    .run();

  db.update(broadcasts)
    .set({ sentCount: sql`max(0, ${broadcasts.sentCount} - 1)` })
    .where(eq(broadcasts.id, row.broadcastId))
    .run();

  audit({ actorId: admin.user.id }, {
    action: "broadcast.wechat",
    targetType: "broadcast",
    targetId: row.broadcastId,
    after: { revoked: row.convId },
  });

  revalidatePath("/admin/broadcast");
  return { ok: true };
}
