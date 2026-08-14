import { apiError, authenticate } from "@/lib/api-tokens/auth";
import { forumGate } from "@/lib/forum/api-gate";
import { runAsApiCaller } from "@/lib/api-tokens/as-caller";
import { fromResult, readJson } from "@/lib/api-tokens/route-helpers";
import { convertMessagesToPost } from "@/lib/forum/convert";

export const dynamic = "force-dynamic";

/**
 * 把一段群聊整理成帖子。
 *
 * ═════════════════════════════════════════
 * 要两个 scope，因为它跨了两片
 * ═════════════════════════════════════════
 *
 * 读那段消息要 `groups:read`，而发出来的帖子**署你的名**，
 * 要 `forum:write`。只要其中一个的话，这条接口就成了
 * 另一个 scope 的绕行路线。
 *
 * 被引用的人同意没同意，判定在 `convertMessagesToPost` 里 ——
 * 没同意的会被隐去。这里不重写那一段：群聊转帖是这个站里
 * 最容易把「群内的话」变成「站外可搜」的动作，
 * 两份判定里更松的那一份会被找到。
 */
export async function POST(request: Request) {
  const auth = await authenticate(request, ["forum:write", "groups:read"]);
  if (!auth.ok) return auth.response;

  const gate = forumGate(auth.caller.user);
  if (gate) return gate;

  const parsed = await readJson<{
    conv_id?: unknown;
    message_ids?: unknown;
    title?: unknown;
    intro?: unknown;
  }>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  if (typeof body.conv_id !== "string" || typeof body.title !== "string") {
    return apiError(400, "bad_request", "要有 conv_id 和 title");
  }
  if (!Array.isArray(body.message_ids) || body.message_ids.length === 0) {
    return apiError(400, "bad_request", "message_ids 要是一个非空数组");
  }

  return runAsApiCaller(auth.caller, async () => {
    const result = await convertMessagesToPost({
      convId: body.conv_id as string,
      messageIds: (body.message_ids as unknown[]).filter((x): x is string => typeof x === "string"),
      title: body.title as string,
      intro: typeof body.intro === "string" ? body.intro : undefined,
    });
    return fromResult(result, { post_id: (result as { postId?: string }).postId });
  });
}
