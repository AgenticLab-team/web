import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { inviteUses, users } from "@/lib/db/schema";
import { shouldRevertReward, shouldReward } from "@/lib/invites/rules";
import { findLedgerByIdempotencyKey, grantPoints, revertPoints } from "@/lib/points/ledger";
import { getSettingInt } from "@/lib/settings/store";

/**
 * 邀请奖励的结算与回滚。
 *
 * **奖励在被邀请人完成首次打卡时才发**，不是注册时 ——
 * 注册即给的话，拉一堆僵尸号就能刷分，而拉僵尸号的成本几乎为零。
 * 打卡本身要求群里发言或论坛活跃达标，也就是说，
 * 只有真的参与了社区的人才会让邀请人拿到奖励。这条门槛是复用现成的反作弊。
 *
 * 回滚同样重要：被邀请人被封 = 这次邀请没带来真实的人。
 * 不回滚的话「刷号被抓也不亏」，那等于在鼓励刷。
 */

export interface SettleResult {
  settled: number;
  reverted: number;
}

/**
 * 结算一个人的邀请奖励。在他打卡成功后调用。
 *
 * 幂等：重复调用不会重复发分（靠 rewardedAt 和 ledger 的幂等键双保险）。
 */
export function settleInviteReward(invitedUserId: string): boolean {
  const use = db
    .select()
    .from(inviteUses)
    .where(eq(inviteUses.invitedUserId, invitedUserId))
    .get();
  if (!use) return false;

  const invitee = db.select().from(users).where(eq(users.id, invitedUserId)).get();
  if (!invitee) return false;

  const eligible = shouldReward({
    inviteeCheckedIn: invitee.lastCheckinDate !== null,
    inviteeStatus: invitee.status,
    alreadyRewarded: use.rewardedAt !== null,
    reverted: use.revertedAt !== null,
  });
  if (!eligible) return false;

  const points = getSettingInt("invite.reward_points", 50);
  if (points <= 0) return false;

  const granted = grantPoints({
    userId: use.inviterId,
    delta: points,
    reason: "邀请奖励（被邀请人已完成首次打卡）",
    ruleKey: "invite",
    refType: "invite_use",
    refId: use.id,
    // 幂等键挂在这一次使用上 —— 同一次邀请永远只发一笔
    idempotencyKey: `invite:${use.id}`,
  });
  if (!granted.ok || granted.duplicate) return false;

  db.update(inviteUses)
    .set({ rewardedAt: Date.now(), rewardPoints: points })
    .where(eq(inviteUses.id, use.id))
    .run();

  return true;
}

/**
 * 回滚某人的邀请奖励。在他被封禁时调用。
 *
 * 走冲正而不是直接扣 —— 积分流水只增不改，
 * 直接扣会让「这笔分怎么没了」永远查不清。
 */
export function revertInviteReward(invitedUserId: string, reason: string): boolean {
  const use = db
    .select()
    .from(inviteUses)
    .where(eq(inviteUses.invitedUserId, invitedUserId))
    .get();
  if (!use) return false;

  const invitee = db.select().from(users).where(eq(users.id, invitedUserId)).get();
  if (!invitee) return false;

  const should = shouldRevertReward({
    inviteeStatus: invitee.status,
    alreadyRewarded: use.rewardedAt !== null,
    reverted: use.revertedAt !== null,
  });
  if (!should) return false;

  /*
   * 走冲正而不是直接扣分 —— 积分流水只增不改。
   * 直接扣的话，「我那 50 分怎么没了」永远查不清。
   */
  const original = findLedgerByIdempotencyKey(`invite:${use.id}`);
  if (!original) return false;

  const result = revertPoints(original.id, "system", `邀请奖励回滚：${reason}`);
  if (!result.ok) return false;

  db.update(inviteUses)
    .set({ revertedAt: Date.now(), revertReason: reason })
    .where(eq(inviteUses.id, use.id))
    .run();

  return true;
}

/**
 * 批量补结算。
 *
 * 结算挂在打卡流程上，但流程可能因为各种原因漏掉（改代码、出异常）——
 * 有一个能兜底重跑的入口，比祈祷流程永不出错可靠。
 */
export function settleAllPending(): SettleResult {
  const pending = db
    .select({ use: inviteUses, status: users.status, lastCheckinDate: users.lastCheckinDate })
    .from(inviteUses)
    .innerJoin(users, eq(users.id, inviteUses.invitedUserId))
    .all();

  let settled = 0;
  let reverted = 0;

  for (const row of pending) {
    if (
      shouldReward({
        inviteeCheckedIn: row.lastCheckinDate !== null,
        inviteeStatus: row.status,
        alreadyRewarded: row.use.rewardedAt !== null,
        reverted: row.use.revertedAt !== null,
      })
    ) {
      if (settleInviteReward(row.use.invitedUserId)) settled++;
    } else if (
      shouldRevertReward({
        inviteeStatus: row.status,
        alreadyRewarded: row.use.rewardedAt !== null,
        reverted: row.use.revertedAt !== null,
      })
    ) {
      if (revertInviteReward(row.use.invitedUserId, "批量核对：被邀请人已被封禁")) reverted++;
    }
  }

  return { settled, reverted };
}
