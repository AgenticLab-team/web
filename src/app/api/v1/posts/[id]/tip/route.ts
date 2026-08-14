import { apiError, authenticate } from "@/lib/api-tokens/auth";
import { forumGate } from "@/lib/forum/api-gate";
import { runAsApiCaller } from "@/lib/api-tokens/as-caller";
import { fromResult, readJson } from "@/lib/api-tokens/route-helpers";
import { sendTip } from "@/lib/forum/tips";

export const dynamic = "force-dynamic";

/**
 * 打赏一篇帖子或某条回复。
 *
 * ═════════════════════════════════════════
 * 它归 `economy:write`，而且**没有幂等**
 * ═════════════════════════════════════════
 *
 * 别的写操作重试是安全的（收藏是切换、打卡是幂等）。
 * 这一条不是：重试一次就是**再送一次积分**。
 *
 * 所以它不假装幂等，也不去猜「这是不是刚才那一次的重试」——
 * 猜错的方向要么是白扣一次，要么是该扣没扣。
 * 客户端要保证不重发，而终端那侧的做法是按下之后立刻禁用按钮，
 * 直到拿到结果。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(request, ["economy:write"]);
  if (!auth.ok) return auth.response;

  const gate = forumGate(auth.caller.user);
  if (gate) return gate;

  const parsed = await readJson<{ amount?: unknown; note?: unknown; reply_id?: unknown }>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const amount = body.amount;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) {
    return apiError(400, "bad_request", "amount 要是一个正整数");
  }

  const { id } = await params;
  const replyId = typeof body.reply_id === "string" ? body.reply_id : null;

  return runAsApiCaller(auth.caller, async () =>
    fromResult(
      await sendTip({
        targetType: replyId ? "reply" : "post",
        targetId: replyId ?? id,
        points: amount,
        note: typeof body.note === "string" ? body.note : undefined,
      }),
    ),
  );
}
