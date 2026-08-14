import { apiError, authenticate } from "@/lib/api-tokens/auth";
import { forumGate } from "@/lib/forum/api-gate";
import { runAsApiCaller } from "@/lib/api-tokens/as-caller";
import { fromResult, readJson } from "@/lib/api-tokens/route-helpers";
import { submitReport } from "@/lib/forum/moderation";

export const dynamic = "force-dynamic";

const REASONS = ["spam", "abuse", "porn", "illegal", "privacy", "offtopic", "other"] as const;

/**
 * 举报一篇帖子或它下面的某条回复。
 *
 * ─────────────────────────────────────────
 * 理由是**枚举**，不是自由文本
 * ─────────────────────────────────────────
 *
 * 自由文本的举报队列没法排序、没法统计、也没法自动升级处置。
 * 而处置队列一旦排不出优先级，真正紧急的那几条会淹在里面。
 *
 * 补充说明照样能写（`detail`），但它是附加的，不是分类本身。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(request, ["forum:write"]);
  if (!auth.ok) return auth.response;

  const gate = forumGate(auth.caller.user);
  if (gate) return gate;

  const parsed = await readJson<{ reason?: unknown; detail?: unknown; reply_id?: unknown }>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const reason = body.reason;
  if (typeof reason !== "string" || !(REASONS as readonly string[]).includes(reason)) {
    return apiError(400, "bad_request", `reason 只能是：${REASONS.join("、")}`);
  }

  const { id } = await params;
  const replyId = typeof body.reply_id === "string" ? body.reply_id : null;

  return runAsApiCaller(auth.caller, async () =>
    fromResult(
      await submitReport({
        targetType: replyId ? "reply" : "post",
        targetId: replyId ?? id,
        reasonCode: reason as (typeof REASONS)[number],
        detail: typeof body.detail === "string" ? body.detail : undefined,
      }),
    ),
  );
}
