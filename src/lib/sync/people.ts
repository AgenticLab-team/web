import "server-only";

import { eq, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { groupMembers, messages, people, users } from "@/lib/db/schema";
import { nekobot } from "@/lib/nekobot/client";

import { runSyncJob, type SyncOptions, type SyncResult } from "./job";

/**
 * 重建 people 表：社群里每个人的显示名、头像与活跃度汇总。
 *
 * 显示名的取值顺序，从可靠到不可靠：
 *   1. 群昵称（group_members.display_name）—— 群成员列表里真实显示的名字
 *   2. 最近一条消息的发送者名 —— 注意是「最近」不是 max()，
 *      SQL 的 max() 按字典序比大小，会让 "wxid_examplemember01" 赢过 "jmr"
 *   3. wx_id 兜底
 *
 * 上游 /users/{wx_id} 的 name 不参与 —— 实测它对部分账号直接返回 wx_id。
 */
export async function syncPeople(options: SyncOptions = {}): Promise<SyncResult> {
  return runSyncJob("avatars", { ...options, scope: "people" }, async () => {
    const now = Date.now();

    // 群昵称：同一个人可能在多个群有不同昵称，取最近同步到的那个
    const nicknames = new Map<string, string>();
    const memberRows = db
      .select({
        wxId: groupMembers.wxId,
        name: groupMembers.displayName,
        syncedAt: groupMembers.syncedAt,
      })
      .from(groupMembers)
      .where(isNull(groupMembers.leftAt))
      .orderBy(groupMembers.syncedAt)
      .all();
    for (const row of memberRows) {
      if (row.name && row.name.trim() && row.name !== row.wxId) {
        nicknames.set(row.wxId, row.name.trim());
      }
    }

    // 每人最近一条消息的发送者名。用窗口函数拿「最新」而不是 max()
    const latestNames = db
      .all<{ wx_id: string; name: string }>(sql`
        SELECT sender_wx_id AS wx_id, sender_name AS name FROM (
          SELECT sender_wx_id, sender_name,
                 ROW_NUMBER() OVER (PARTITION BY sender_wx_id ORDER BY ts DESC) AS rn
          FROM messages
          WHERE sender_name IS NOT NULL AND sender_name <> '' AND is_send = 0
        ) WHERE rn = 1
      `);
    const fallbackNames = new Map(latestNames.map((r) => [r.wx_id, r.name]));

    const stats = db
      .select({
        wxId: messages.senderWxId,
        messages: sql<number>`count(*)`,
        quality: sql<number>`sum(${messages.isQuality})`,
        firstSeen: sql<number>`min(${messages.ts})`,
        lastSeen: sql<number>`max(${messages.ts})`,
        groups: sql<number>`count(distinct ${messages.convId})`,
      })
      .from(messages)
      .where(eq(messages.isSend, false))
      .groupBy(messages.senderWxId)
      .all();

    const everyone = new Set<string>([
      ...nicknames.keys(),
      ...fallbackNames.keys(),
      ...stats.map((s) => s.wxId),
      ...memberRows.map((m) => m.wxId),
    ]);

    const statsMap = new Map(stats.map((s) => [s.wxId, s]));
    const avatars = await harvestAvatars();

    let written = 0;
    db.transaction((tx) => {
      for (const wxId of everyone) {
        const name = nicknames.get(wxId) ?? fallbackNames.get(wxId) ?? wxId;
        const stat = statsMap.get(wxId);
        const avatar = avatars.get(wxId);

        tx.insert(people)
          .values({
            wxId,
            displayName: name,
            avatarUrl: avatar ?? null,
            avatarSource: avatar ? "friend_request" : null,
            messages: stat?.messages ?? 0,
            qualityMessages: Number(stat?.quality ?? 0),
            groupCount: stat?.groups ?? 0,
            firstSeen: stat?.firstSeen,
            lastSeen: stat?.lastSeen,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: people.wxId,
            set: {
              displayName: name,
              // 已有头像就别用 null 覆盖掉
              ...(avatar ? { avatarUrl: avatar, avatarSource: "friend_request" as const } : {}),
              messages: stat?.messages ?? 0,
              qualityMessages: Number(stat?.quality ?? 0),
              groupCount: stat?.groups ?? 0,
              firstSeen: stat?.firstSeen,
              lastSeen: stat?.lastSeen,
              updatedAt: now,
            },
          })
          .run();
        written++;
      }

      // 已注册账号的微信昵称跟着一起更新；站内昵称是用户自己的选择，绝不覆盖
      const registered = db.select().from(users).all();
      for (const user of registered) {
        if (!user.wxId) continue;
        const name = nicknames.get(user.wxId) ?? fallbackNames.get(user.wxId);
        const avatar = avatars.get(user.wxId);
        if (!name && !avatar) continue;
        if (name === user.wxNickname && (!avatar || avatar === user.wxAvatarUrl)) continue;
        tx.update(users)
          .set({
            ...(name ? { wxNickname: name } : {}),
            ...(avatar ? { wxAvatarUrl: avatar } : {}),
            updatedAt: now,
          })
          .where(eq(users.id, user.id))
          .run();
      }
    });

    return {
      fetched: everyone.size,
      written,
      note: `头像 ${avatars.size} 个（仅好友申请可得）`,
    };
  });
}

/**
 * 头像只有 /friend-requests 拿得到（实测 24/24 条都带 avatar_full 940x940，
 * 而排行榜与用户画像的 avatar 字段 0/25 有值）。
 * 没发过好友申请的人拿不到头像，前端用昵称首字生成占位。
 */
async function harvestAvatars(): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const requests = await nekobot.friendRequests({ limit: 200 }).catch((err) => {
    // 静默失败会让「头像 0 个」看起来像是上游没有数据，而不是请求出错
    console.error("头像收割失败", err);
    return null;
  });
  if (!requests) return result;

  for (const request of requests.items) {
    const avatar = request.avatar_full || request.avatar;
    if (avatar) result.set(request.wx_id, avatar);
  }
  return result;
}

/** 批量取显示名，供排行榜、检索结果等处使用 */
export function displayNamesOf(wxIds: string[]): Map<string, string> {
  if (wxIds.length === 0) return new Map();
  const rows = db.select({ wxId: people.wxId, name: people.displayName }).from(people).all();
  const all = new Map(rows.map((r) => [r.wxId, r.name]));
  return new Map(wxIds.map((id) => [id, all.get(id) ?? id]));
}

export function peopleByIds(wxIds: string[]) {
  const rows = db.select().from(people).all();
  const map = new Map(rows.map((r) => [r.wxId, r]));
  return new Map(
    wxIds.map((id) => [
      id,
      map.get(id) ?? {
        wxId: id,
        displayName: id,
        avatarUrl: null,
        avatarSource: null,
        messages: 0,
        qualityMessages: 0,
        groupCount: 0,
        firstSeen: null,
        lastSeen: null,
        updatedAt: 0,
      },
    ]),
  );
}
