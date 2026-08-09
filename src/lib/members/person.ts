import "server-only";

import { and, eq, inArray, isNull } from "drizzle-orm";

import { db } from "@/lib/db";
import { groupMembers, people } from "@/lib/db/schema";
import type { VisibleGroup } from "@/lib/queries/visibility";
import { resolveDisplayName } from "@/lib/users/display-name";

export interface PersonProfile {
  wxId: string;
  name: string;
  avatarUrl: string | null;
  /** 查看者与这个人的共同群 —— 页面上一切统计都限定在这个范围 */
  sharedGroups: { convId: string; name: string }[];
  /** 共同群内的发言总数。不用 people.messages：那是全站口径，会泄露他在别的群的活跃度 */
  messages: number;
}

/**
 * 成员主页的数据。返回 null 表示「对这个查看者而言此人不存在」——
 * 没有共同群就该 404，而不是给一个空页面确认 wx_id 有效。
 */
export function personProfileFor(
  wxId: string,
  viewerGroups: VisibleGroup[],
): PersonProfile | null {
  if (viewerGroups.length === 0) return null;

  const memberships = db
    .select({
      convId: groupMembers.convId,
      displayName: groupMembers.displayName,
      wxName: groupMembers.wxName,
      avatarUrl: groupMembers.avatarUrl,
      messages: groupMembers.messages,
    })
    .from(groupMembers)
    .where(
      and(
        eq(groupMembers.wxId, wxId),
        inArray(
          groupMembers.convId,
          viewerGroups.map((g) => g.convId),
        ),
        // 退群即从共同群里消失 —— 和消息可见权同一条规则
        isNull(groupMembers.leftAt),
      ),
    )
    .all();

  if (memberships.length === 0) return null;

  const person = db
    .select({ displayName: people.displayName, avatarUrl: people.avatarUrl })
    .from(people)
    .where(eq(people.wxId, wxId))
    .get();

  const nameByConv = new Map(viewerGroups.map((g) => [g.convId, g.name]));

  return {
    wxId,
    name: resolveDisplayName(
      [
        person?.displayName,
        ...memberships.map((m) => m.displayName),
        ...memberships.map((m) => m.wxName),
      ],
      { wxId },
    ),
    avatarUrl: person?.avatarUrl ?? memberships.find((m) => m.avatarUrl)?.avatarUrl ?? null,
    sharedGroups: memberships.map((m) => ({
      convId: m.convId,
      name: nameByConv.get(m.convId) ?? "群聊",
    })),
    messages: memberships.reduce((sum, m) => sum + m.messages, 0),
  };
}
