import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";

import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { groupMemberEvents, groupMembers, roles, userRoles, users } from "@/lib/db/schema";
import { revocationsFor } from "@/lib/sync/roster-rules";

/**
 * 消费进出群事件。
 *
 * ─────────────────────────────────────────
 * `pendingMemberEvents()` 一直没有人调
 * ─────────────────────────────────────────
 *
 * `group_member_events` 从一开始就在记 join / leave / rename，
 * `processed_at` 那一列的注释写着「是否已触发权限调整」——
 * 而**没有任何地方触发过**。每一行的 `processed_at` 都是 null。
 *
 * 要澄清一件被说错过的事：**群消息的可见权不需要这一步**。
 * `visibleGroupsFor` 要求 `left_at IS NULL`，所以标上退群那一刻
 * 内容就看不见了。真正一直没被收回的是**挂在这个群上的身份组** ——
 * 它存在 `user_roles` 里，和名册没有任何关联，不收就一直挂着。
 *
 * 一个已经退群的人，还留着那个群的管理权限。
 */

export interface MemberEventReport {
  processed: number;
  revoked: number;
  /** 退光了所有群的人 —— 只报给管理员，不自动处理 */
  leftEverything: number;
}

export function processMemberEvents(now = Date.now()): MemberEventReport {
  const pending = db
    .select()
    .from(groupMemberEvents)
    .where(isNull(groupMemberEvents.processedAt))
    .all();

  const report: MemberEventReport = { processed: 0, revoked: 0, leftEverything: 0 };
  if (pending.length === 0) return report;

  for (const event of pending) {
    if (event.event === "leave") report.revoked += revokeGroupRoles(event.convId, event.wxId, now);

    db.update(groupMemberEvents)
      .set({ processedAt: now })
      .where(eq(groupMemberEvents.id, event.id))
      .run();
    report.processed++;
  }

  report.leftEverything = leftEverything().length;
  return report;
}

/**
 * 收回这个人在这个群上的身份组。
 *
 * **只收 scope 正好是这个群的**。全站身份组不动 ——
 * 一个站务退了某个群，不该因此丢掉全站权限；
 * 而按 wx_id 找到人之后一刀切收掉所有角色，
 * 是那种「跑一次就再也回不去」的操作。
 */
function revokeGroupRoles(convId: string, wxId: string, now: number): number {
  const user = db.select({ id: users.id }).from(users).where(eq(users.wxId, wxId)).get();
  if (!user) return 0; // 没有站内账号的人没有身份组可收

  let count = 0;
  for (const target of revocationsFor(convId)) {
    const held = db
      .select({ id: userRoles.id, roleId: userRoles.roleId })
      .from(userRoles)
      .where(
        and(
          eq(userRoles.userId, user.id),
          eq(userRoles.scopeType, target.scopeType),
          eq(userRoles.scopeId, target.scopeId),
          isNull(userRoles.revokedAt),
        ),
      )
      .all();

    for (const row of held) {
      db.update(userRoles).set({ revokedAt: now }).where(eq(userRoles.id, row.id)).run();

      const role = db
        .select({ name: roles.name })
        .from(roles)
        .where(eq(roles.id, row.roleId))
        .get();

      /*
       * 这一步要留痕。
       *
       * 它是系统自己做的、不可逆（要恢复得管理员重新授予）、
       * 而且当事人不会收到任何提示 —— 三条加起来，
       * 不记的话「我的权限怎么没了」这个问题永远没有答案。
       */
      audit(
        { actorId: "system" },
        {
          action: "role.revoke",
          targetType: "user",
          targetId: user.id,
          targetLabel: role?.name ?? row.roleId,
          reason: target.reason,
          after: { convId, auto: true },
        },
      );
      count++;
    }
  }
  return count;
}

/**
 * 已经不在任何群里、但账号还活着的人。
 *
 * ─────────────────────────────────────────
 * 只报，不自动封
 * ─────────────────────────────────────────
 *
 * 一次名册同步出错就能把一群人挡在门外，而**把真的成员关在门外的代价，
 * 比让一个已经退群的人多登录几天大得多**。这个项目已经吃过一次
 * 同类的亏：早期把接口异常 catch 成「你不是社群成员」，
 * 结果所有人都被告知没资格。
 *
 * 所以这里只给名单，由人来决定。
 */
export function leftEverything(): { userId: string; wxId: string }[] {
  return db
    .select({ userId: users.id, wxId: users.wxId })
    .from(users)
    .where(
      and(
        sql`${users.wxId} is not null`,
        eq(users.status, "active"),
        sql`not exists (
          select 1 from ${groupMembers}
          where ${groupMembers.wxId} = ${users.wxId}
            and ${groupMembers.leftAt} is null
        )`,
      ),
    )
    .all()
    .filter((r): r is { userId: string; wxId: string } => r.wxId !== null);
}
