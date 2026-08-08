import "server-only";

import { and, asc, eq, gte, lt } from "drizzle-orm";

import type { CurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { messages, people } from "@/lib/db/schema";
import { assertGroupAccess } from "@/lib/queries/visibility";
import { endOfDayMs, startOfDayMs } from "@/lib/time";
import { resolveDisplayName } from "@/lib/users/display-name";

export interface PickableMessage {
  id: string;
  senderWxId: string;
  senderName: string;
  avatarUrl: string | null;
  content: string;
  type: string;
  ts: number;
}

/**
 * 取某天某群的消息，供转帖时挑选。
 *
 * 权限走统一收口：不在这个群就拿不到任何消息，
 * 而不是「拿到之后前端不显示」。
 */
export function messagesOfDay(
  user: CurrentUser | null,
  convId: string,
  date: string,
): PickableMessage[] | null {
  if (!assertGroupAccess(user, convId)) return null;

  const rows = db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.convId, convId),
        eq(messages.isSend, false),
        gte(messages.ts, startOfDayMs(date)),
        lt(messages.ts, endOfDayMs(date)),
      ),
    )
    .orderBy(asc(messages.ts))
    .all();

  if (rows.length === 0) return [];

  const profiles = new Map(
    db
      .select({ wxId: people.wxId, name: people.displayName, avatar: people.avatarUrl })
      .from(people)
      .all()
      .map((p) => [p.wxId, p]),
  );

  return rows.map((row) => ({
    id: row.id,
    senderWxId: row.senderWxId,
    senderName: resolveDisplayName([profiles.get(row.senderWxId)?.name, row.senderName], {
      wxId: row.senderWxId,
      fallback: "成员",
    }),
    avatarUrl: profiles.get(row.senderWxId)?.avatar ?? null,
    content: row.content,
    type: row.type,
    ts: row.ts,
  }));
}
