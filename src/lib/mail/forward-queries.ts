import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { mailBoxes, users } from "@/lib/db/schema";

import { senderConfigured } from "./sender";

/**
 * 转发那一块要显示的东西，**一次查完**。
 *
 * ─────────────────────────────────────────
 * 三种箱子在这里合成一张表
 * ─────────────────────────────────────────
 *
 * 别处（一次性箱、自有域名别名、申领来的）是三张分开的列表，
 * 因为三者的**关注点不同**：等码 / 地址 / 别错过续期。
 *
 * 而「哪些箱子要转发」是同一个问题问三遍 —— 分成三处的话，
 * 人要在三个地方各拨一次开关，然后自己记住哪些开了。
 */

export interface ForwardState {
  /** 站里配没配发信。没配的话这一整块不出现 */
  available: boolean;
  email: string | null;
  verified: boolean;
  boxes: { id: string; address: string; kind: string; forwardEnabled: boolean }[];
}

export function forwardState(userId: string): ForwardState {
  if (!senderConfigured()) {
    return { available: false, email: null, verified: false, boxes: [] };
  }

  const user = db
    .select({ email: users.email, verifiedAt: users.emailVerifiedAt })
    .from(users)
    .where(eq(users.id, userId))
    .get();

  const boxes = db
    .select({
      id: mailBoxes.id,
      localPart: mailBoxes.localPart,
      domain: mailBoxes.domain,
      kind: mailBoxes.kind,
      forwardEnabled: mailBoxes.forwardEnabled,
    })
    .from(mailBoxes)
    .where(
      and(
        eq(mailBoxes.userId, userId),
        inArray(mailBoxes.status, ["active", "full", "grace"]),
      ),
    )
    .all()
    .map((b) => ({
      id: b.id,
      // 显示用那一份是算出来的 —— 全站口径
      address: `${b.localPart}@${b.domain}`,
      kind: b.kind,
      forwardEnabled: b.forwardEnabled,
    }));

  return {
    available: true,
    email: user?.email ?? null,
    verified: Boolean(user?.verifiedAt),
    boxes,
  };
}
