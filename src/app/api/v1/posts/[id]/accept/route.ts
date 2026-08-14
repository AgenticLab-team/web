import { apiError, authenticate } from "@/lib/api-tokens/auth";
import { forumGate } from "@/lib/forum/api-gate";
import { runAsApiCaller } from "@/lib/api-tokens/as-caller";
import { fromResult, readJson } from "@/lib/api-tokens/route-helpers";
import { acceptAnswer } from "@/lib/forum/qa";

export const dynamic = "force-dynamic";

/**
 * 采纳一条回复（问答帖）。
 *
 * 帖子上挂着悬赏的话，采纳的同时把悬赏结算给被采纳的人 ——
 * 这一步在 `acceptAnswer` 里，不在这儿。分开写的话，
 * 「采纳了但赏金没到」会成为一种只在 API 这条路上出现的状态。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(request, ["forum:write"]);
  if (!auth.ok) return auth.response;

  const gate = forumGate(auth.caller.user);
  if (gate) return gate;

  const parsed = await readJson<{ reply_id?: unknown }>(request);
  if (!parsed.ok) return parsed.response;

  const replyId = parsed.body.reply_id;
  if (typeof replyId !== "string" || !replyId) {
    return apiError(400, "bad_request", "要有 reply_id");
  }

  const { id } = await params;
  return runAsApiCaller(auth.caller, async () =>
    fromResult(await acceptAnswer({ postId: id, replyId })),
  );
}
