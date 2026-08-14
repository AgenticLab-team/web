import { NextResponse } from "next/server";

import { authenticate } from "@/lib/api-tokens/auth";
import { listLoginHistory, listSessions } from "@/lib/auth/devices";

export const dynamic = "force-dynamic";

/**
 * 我在哪些设备上登录着，以及最近的登录历史。
 *
 * ─────────────────────────────────────────
 * 这里列的是**网页会话**，不是令牌
 * ─────────────────────────────────────────
 *
 * 两者在终端里很容易被混成一件事，而它们的性质完全不同：
 * 会话有设备、有 IP、会过期、能一键下线；令牌就是一串字符，
 * 抄到哪里都能用（`lib/api-tokens/rules.ts` 顶上那段）。
 *
 * 所以终端那一屏把它们分成两块，各有各的撤销按钮。
 *
 * **当前这次 API 调用不在这份列表里** —— 它没有会话。
 * 不说清楚的话，人会在这一页上找不到「我现在这个终端」然后困惑。
 */
export async function GET(request: Request) {
  const auth = await authenticate(request, ["me:read"]);
  if (!auth.ok) return auth.response;

  const { user } = auth.caller;
  return NextResponse.json({
    /*
     * 不传 currentTokenHash：令牌这条路上没有会话，
     * 所以这份列表里的每一条都是「别的地方」。
     */
    sessions: listSessions(user.id),
    history: listLoginHistory(user.id),
    note: "这些是网页登录的会话。你现在用的是一把令牌，它在「开放 API」那一栏里",
  });
}
