import { apiError, authenticate } from "@/lib/api-tokens/auth";
import { forumGate } from "@/lib/forum/api-gate";
import { runAsApiCaller } from "@/lib/api-tokens/as-caller";
import { fromResult, readJson } from "@/lib/api-tokens/route-helpers";
import { REACTION_KINDS } from "@/lib/db/schema";
import { toggleReaction, type ReactionKind } from "@/lib/forum/social";

export const dynamic = "force-dynamic";

/**
 * 给帖子或某条回复加/去一个态度。
 *
 * ─────────────────────────────────────────
 * 是**四种固定的态度**，不是任意 emoji
 * ─────────────────────────────────────────
 *
 * `useful / insight / precise / love` —— 站里刻意没有做成
 * 「贴任意表情」，因为那样统计不出任何东西：一百个不同的表情
 * 摊开来，每一个都是 1。
 *
 * 所以这里也不接 emoji 字段。传一个认不出的 `kind` 直接拒绝，
 * 而不是默默换成默认那一种 —— 后者会让人以为自己贴上去了。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(request, ["forum:write"]);
  if (!auth.ok) return auth.response;

  const gate = forumGate(auth.caller.user);
  if (gate) return gate;

  const parsed = await readJson<{ kind?: unknown; target?: unknown; reply_id?: unknown }>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const kind = body.kind;
  if (typeof kind !== "string" || !(REACTION_KINDS as readonly string[]).includes(kind)) {
    return apiError(400, "bad_request", `kind 只能是：${REACTION_KINDS.join("、")}`);
  }

  const { id } = await params;
  /*
   * 目标可以是帖子本身，也可以是它下面的某条回复。
   * 传了 reply_id 就是回复 —— 不用再多一个 `target` 字段说同一件事。
   */
  const replyId = typeof body.reply_id === "string" ? body.reply_id : null;

  return runAsApiCaller(auth.caller, async () => {
    const result = await toggleReaction({
      targetType: replyId ? "reply" : "post",
      targetId: replyId ?? id,
      kind: kind as ReactionKind,
    });
    return fromResult(result, { active: result.active });
  });
}
