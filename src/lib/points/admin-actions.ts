"use server";

import { revalidatePath } from "next/cache";

import { requireWritableAdmin } from "@/lib/admin/guard";
import { audit } from "@/lib/audit";

import { revertPoints } from "./ledger";

/**
 * 冲正一笔流水。
 *
 * ─────────────────────────────────────────
 * 人工发放 / 扣除**不在这里**
 * ─────────────────────────────────────────
 *
 * `lib/admin/user-actions.ts` 里已经有 `adjustPoints`，而且比这里
 * 该有的更完整：阈值可配（`points.large_adjust_threshold`）、
 * 大额要 `points.adjust.large` 权限、审计里带 before/after 和昵称。
 *
 * 我一开始在这里又写了一个 —— 那正是这个 session 一路在拆的东西：
 * 同一件事两份实现，早晚有一份被改、另一份没改，而且没人说得清
 * 哪一份算数。全站流水页直接调那一个。
 *
 * ─────────────────────────────────────────
 * 冲正写反向流水，不动原记录
 * ─────────────────────────────────────────
 *
 * 账本只增不改。改掉原记录的话，「当时到底发生了什么」
 * 就再也查不出来了 —— 而那是这张表存在的全部意义。
 */

export interface RevertResult {
  ok: boolean;
  error?: string;
  balance?: number;
}

export async function revertLedgerEntry(ledgerId: string, reason: string): Promise<RevertResult> {
  const admin = await requireWritableAdmin("points.adjust");

  const trimmed = reason.trim().replace(/\s+/g, " ");
  if (trimmed.length < 4) {
    return { ok: false, error: "冲正也要写理由，至少 4 个字 —— 它会留在当事人的账单里" };
  }

  const result = revertPoints(ledgerId, admin.user.id, trimmed);
  if (!result.ok) return { ok: false, error: result.error ?? "没成功" };

  audit(
    { actorId: admin.user.id },
    {
      action: "points.revert",
      targetType: "points_ledger",
      targetId: ledgerId,
      after: { balance: result.balance },
      reason: trimmed,
    },
  );

  revalidatePath("/admin/points/ledger");
  return { ok: true, balance: result.balance };
}
