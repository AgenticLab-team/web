import { NextResponse } from "next/server";

import { authenticate } from "@/lib/api-tokens/auth";
import { forumGate } from "@/lib/forum/api-gate";
import { buildViewerContext } from "@/lib/forum/context";
import { listBoards } from "@/lib/forum/queries";

export const dynamic = "force-dynamic";

/**
 * 有哪些版块。
 *
 * ═════════════════════════════════════════
 * 每条要带上「我能不能在这里发帖」
 * ═════════════════════════════════════════
 *
 * 不带的话，终端只能把所有版块都列出来让人选，
 * 而他选中一个发不了的，写完三百字才拿到一句 403。
 *
 * 判定本来就在 `listBoards(viewer)` 里做过了（它按可见性筛过一遍），
 * 把结果一起送出来是零成本的 —— 而少这一个字段的代价，
 * 是每一个用终端发帖的人都要撞一次墙。
 */
export async function GET(request: Request) {
  const auth = await authenticate(request, ["forum:read"]);
  if (!auth.ok) return auth.response;

  const gate = forumGate(auth.caller.user);
  if (gate) return gate;

  return NextResponse.json({ boards: listBoards(buildViewerContext(auth.caller.user)) });
}
