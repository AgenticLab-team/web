import { authenticate } from "@/lib/api-tokens/auth";
import { forumGate } from "@/lib/forum/api-gate";
import { runAsApiCaller } from "@/lib/api-tokens/as-caller";
import { fromResult, readJson } from "@/lib/api-tokens/route-helpers";
import { toggleBookmark } from "@/lib/forum/social";

export const dynamic = "force-dynamic";

/**
 * 收藏 / 取消收藏。
 *
 * 它要 `me:write` 而不是 `forum:write`：收藏是「我的东西」，
 * 不是往论坛里写内容 —— 别人看不到我收藏了什么。
 *
 * 返回体里带上切换**之后**的状态。`toggleBookmark` 是切换而不是设置，
 * 而脚本会重试；带上结果之后，重试的那一方能自己看出要不要再来一次。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(request, ["me:write"]);
  if (!auth.ok) return auth.response;

  const gate = forumGate(auth.caller.user);
  if (gate) return gate;

  // 请求体可有可无 —— 这条只要一个帖子 id
  await readJson(request).catch(() => null);

  const { id } = await params;
  return runAsApiCaller(auth.caller, async () => {
    const result = await toggleBookmark(id);
    return fromResult(result, { bookmarked: result.active });
  });
}
