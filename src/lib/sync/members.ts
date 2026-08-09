import "server-only";

import { and, eq, isNull } from "drizzle-orm";

import { db } from "@/lib/db";
import { groupMemberEvents, groupMembers, groups } from "@/lib/db/schema";
import { normalizeAvatarUrl } from "@/lib/avatar";
import { nekobot } from "@/lib/nekobot/client";
import { checkRoster } from "@/lib/sync/roster-rules";

import { runSyncJob, type SyncOptions, type SyncResult } from "./job";

/**
 * 同步群成员名册。
 *
 * 除了让绑定时的成员判定走本地，这个任务还负责产出进出群事件 ——
 * 有人退群后必须自动收回该群的消息可见权，那条逻辑由 group_member_events 驱动。
 */
export async function syncGroupMembers(
  convId: string,
  options: SyncOptions = {},
): Promise<SyncResult> {
  return runSyncJob("members", { ...options, scope: convId }, async () => {
    const ROSTER_LIMIT = 2000;
    const upstream = await nekobot.members(convId, { limit: ROSTER_LIMIT });
    const now = Date.now();

    const existing = db
      .select()
      .from(groupMembers)
      .where(eq(groupMembers.convId, convId))
      .all();
    const existingMap = new Map(existing.map((m) => [m.wxId, m]));

    /*
     * 先判一次这份名册可不可信。
     *
     * 下面那句「上游名册里消失的人视为退群」在上游正常时是对的，
     * 在上游不正常时是灾难性的：一次空响应就会把**整个群的人
     * 全部标成退群**，而 `visibleGroupsFor` 要求 left_at IS NULL ——
     * 于是这个群的聊天记录对所有成员同时消失，
     * 症状是「网站坏了」，没有任何地方会告诉你是名册同步干的。
     *
     * 判据见 roster-rules.ts。拦下来的**只是缺席推断**：
     * 名册里出现的人照常更新，上游明确标了 left 的也照常算 ——
     * 那些是上游说出来的事实，不是我们推断出来的。
     */
    const knownActive = existing.filter((m) => !m.leftAt).length;
    const upstreamIds = new Set(upstream.map((m) => m.wx_id));
    const missing = existing.filter((m) => !m.leftAt && !upstreamIds.has(m.wxId)).length;
    const verdict = checkRoster({
      fetched: upstream.length,
      limit: ROSTER_LIMIT,
      knownActive,
      missing,
    });

    let written = 0;

    db.transaction((tx) => {
      for (const member of upstream) {
        const prior = existingMap.get(member.wx_id);

        if (!prior) {
          tx.insert(groupMemberEvents)
            .values({ convId, wxId: member.wx_id, event: "join" })
            .run();
        } else if (prior.leftAt && !member.left) {
          tx.insert(groupMemberEvents)
            .values({ convId, wxId: member.wx_id, event: "join" })
            .run();
        } else if (!prior.leftAt && member.left) {
          tx.insert(groupMemberEvents)
            .values({ convId, wxId: member.wx_id, event: "leave" })
            .run();
        } else if (prior.displayName && prior.displayName !== member.group_nickname) {
          tx.insert(groupMemberEvents)
            .values({
              convId,
              wxId: member.wx_id,
              event: "rename",
              detail: { from: prior.displayName, to: member.group_nickname },
            })
            .run();
        }

        const avatar = normalizeAvatarUrl(member.avatar_full || member.avatar);

        tx.insert(groupMembers)
          .values({
            convId,
            wxId: member.wx_id,
            displayName: member.group_nickname,
            wxName: member.name,
            avatarUrl: avatar,
            messages: member.messages,
            joinedAt: prior?.joinedAt ?? now,
            leftAt: member.left ? (prior?.leftAt ?? now) : null,
            syncedAt: now,
          })
          .onConflictDoUpdate({
            target: [groupMembers.convId, groupMembers.wxId],
            set: {
              displayName: member.group_nickname,
              wxName: member.name,
              // 拿不到新头像时保留旧的，不要用 null 覆盖
              ...(avatar ? { avatarUrl: avatar } : {}),
              messages: member.messages,
              leftAt: member.left ? (prior?.leftAt ?? now) : null,
              syncedAt: now,
            },
          })
          .run();

        written++;
        existingMap.delete(member.wx_id);
      }

      // 上游名册里消失的人视为退群 —— 只在这份名册可信时
      for (const [wxId, prior] of verdict.trust ? existingMap : []) {
        if (prior.leftAt) continue;
        tx.update(groupMembers)
          .set({ leftAt: now, syncedAt: now })
          .where(and(eq(groupMembers.convId, convId), eq(groupMembers.wxId, wxId)))
          .run();
        tx.insert(groupMemberEvents)
          .values({ convId, wxId, event: "leave", detail: { reason: "从上游名册消失" } })
          .run();
      }
    });

    db.update(groups)
      .set({ memberCount: upstream.filter((m) => !m.left).length, updatedAt: now })
      .where(eq(groups.convId, convId))
      .run();

    return {
      fetched: upstream.length,
      written,
      // 不可信时要**说出来**：静默跳过等于同步一直在假装成功
      note: verdict.trust ? undefined : verdict.message,
    };
  });
}

export async function syncAllMembers(options: SyncOptions = {}): Promise<SyncResult> {
  const enabled = db.select().from(groups).where(eq(groups.syncEnabled, true)).all();

  let fetched = 0;
  let written = 0;
  const failures: string[] = [];

  for (const group of enabled) {
    try {
      const result = await syncGroupMembers(group.convId, options);
      fetched += result.fetched;
      written += result.written;
    } catch (err) {
      failures.push(`${group.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    fetched,
    written,
    note: failures.length ? `${failures.length} 个群失败：${failures.join("; ")}` : undefined,
  };
}

/** 待处理的进出群事件，供权限回收任务消费 */
export function pendingMemberEvents() {
  return db
    .select()
    .from(groupMemberEvents)
    .where(isNull(groupMemberEvents.processedAt))
    .all();
}
