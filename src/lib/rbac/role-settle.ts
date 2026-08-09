import "server-only";

import { and, eq, isNull } from "drizzle-orm";

import { evaluateEligibility, type Rule } from "@/lib/activities/eligibility";
import { computeAllStats } from "@/lib/activities/stats";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { userRoles } from "@/lib/db/schema";

import { holdersOf, listRoles } from "./role-admin";
import { planSettle, SYSTEM_ACTOR } from "./role-rules";

/**
 * 自动授予 / 回收身份组。
 *
 * ─────────────────────────────────────────
 * 规则复用活动那套资格引擎
 * ─────────────────────────────────────────
 *
 * schema 上 `auto_grant_rule` 那一行注释写着「复用活动系统的资格引擎
 * 规则 JSON」—— 而在这个文件之前，没有任何地方读过它。
 *
 * 复用是对的：那套引擎已经能表达「累计积分 ≥ N」「最近 30 天活跃
 * ≥ N 天」「在某个群里」这些条件，还能解释**为什么不够格**。
 * 再造一套的话，两套判定语义早晚分叉。
 *
 * ─────────────────────────────────────────
 * 挂在已经在跑的那一轮定时任务上
 * ─────────────────────────────────────────
 *
 * 和定时发布一样 —— 多一个定时器就多一处会悄悄停掉、
 * 而且没人看得出来的东西。
 */

export interface RoleSettleResult {
  granted: number;
  revoked: number;
  /** 够格但名额满了的人次 —— 名额定小了要看得出来 */
  waitlisted: number;
  /** 配了自动规则、但因为带危险权限被拦下的组 */
  blocked: string[];
}

export function settleAutoRoles(now = Date.now()): RoleSettleResult {
  const result: RoleSettleResult = { granted: 0, revoked: 0, waitlisted: 0, blocked: [] };

  const configured = listRoles(now).filter((r) => r.autoGrantRule != null);
  if (configured.length === 0) return result;

  /*
   * 指标一次算完，所有组共用。
   *
   * 逐个组去算的话，一轮里同样的统计要重复跑 N 遍 ——
   * computeAllStats 本来就是为「一次算全部人」设计的。
   */
  const stats = computeAllStats();

  for (const role of configured) {
    /*
     * **每一轮都重新判一次能不能自动发**，不只在保存时判。
     *
     * 保存时这个组可能没有危险权限，而后来有人给它加了一个 ——
     * 只在保存时判的话，那条规则会继续把危险权限发出去，
     * 而且没有任何地方会提。
     */
    if (!role.autoGrantAllowed) {
      result.blocked.push(role.key);
      continue;
    }

    const eligible = stats
      .filter((s) => evaluateEligibility(role.autoGrantRule as Rule, s).eligible)
      .map((s) => s.userId);

    const plan = planSettle({
      eligible,
      holders: holdersOf(role.id, now),
      maxHolders: role.maxHolders,
      autoRevoke: role.autoRevoke,
    });

    for (const userId of plan.revoke) {
      db.update(userRoles)
        .set({
          revokedAt: now,
          revokedBy: SYSTEM_ACTOR,
          revokeReason: "不再满足自动授予条件",
        })
        .where(
          and(
            eq(userRoles.userId, userId),
            eq(userRoles.roleId, role.id),
            isNull(userRoles.revokedAt),
          ),
        )
        .run();
      result.revoked++;
    }

    for (const userId of plan.grant) {
      /*
       * 之前撤销过的行还在（只增不改），所以这里是插一条新的。
       * 唯一索引是 (user, role, scopeType, scopeId) —— 撤销过的那条
       * 会挡住新插入，所以先把它清掉再插。
       *
       * 清掉的是**已撤销**的行，不动有效的那条。
       */
      db.delete(userRoles)
        .where(
          and(
            eq(userRoles.userId, userId),
            eq(userRoles.roleId, role.id),
            isNull(userRoles.scopeType),
          ),
        )
        .run();

      db.insert(userRoles)
        .values({
          userId,
          roleId: role.id,
          grantedBy: SYSTEM_ACTOR,
          grantReason: `满足「${role.name}」的自动授予条件`,
        })
        .run();
      result.granted++;
    }

    result.waitlisted += plan.waitlisted.length;

    if (plan.grant.length > 0 || plan.revoke.length > 0) {
      audit(
        { actorId: SYSTEM_ACTOR },
        {
          action: "rbac.role.auto_settle",
          targetType: "role",
          targetId: role.id,
          targetLabel: role.name,
          after: {
            granted: plan.grant.length,
            revoked: plan.revoke.length,
            waitlisted: plan.waitlisted.length,
          },
        },
      );
    }
  }

  return result;
}
