import { apiError, authenticate } from "@/lib/api-tokens/auth";
import { forumGate } from "@/lib/forum/api-gate";
import { runAsApiCaller } from "@/lib/api-tokens/as-caller";
import { fromResult, readJson } from "@/lib/api-tokens/route-helpers";
import { castVote } from "@/lib/forum/polls";
import { pollOfPost } from "@/lib/forum/polls-queries";

export const dynamic = "force-dynamic";

/**
 * 在帖子里的投票上投一票。
 *
 * ─────────────────────────────────────────
 * 路径上是**帖子 id**，不是投票 id
 * ─────────────────────────────────────────
 *
 * 一个帖子最多挂一个投票，所以投票 id 对调用方是多余的一层：
 * 他手上有帖子 id（那是他刚读过的那条），却要先发一次请求
 * 把它换成投票 id 才能投。
 *
 * 换算在这里做一次，而不是让每个客户端各做一遍。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(request, ["forum:write"]);
  if (!auth.ok) return auth.response;

  const gate = forumGate(auth.caller.user);
  if (gate) return gate;

  const parsed = await readJson<{ options?: unknown }>(request);
  if (!parsed.ok) return parsed.response;

  const options = parsed.body.options;
  if (!Array.isArray(options) || options.length === 0) {
    return apiError(400, "bad_request", "options 要是一个非空的选项 id 数组");
  }

  const { id } = await params;
  const poll = pollOfPost(id, auth.caller.user.id);
  if (!poll) return apiError(404, "not_found", "这篇帖子上没有投票");

  return runAsApiCaller(auth.caller, async () =>
    fromResult(
      await castVote({
        pollId: poll.id,
        optionIds: options.filter((o): o is string => typeof o === "string"),
      }),
    ),
  );
}
