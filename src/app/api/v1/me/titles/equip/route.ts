import { authenticate } from "@/lib/api-tokens/auth";
import { runAsApiCaller } from "@/lib/api-tokens/as-caller";
import { fromResult, readJson } from "@/lib/api-tokens/route-helpers";
import { equipTitle } from "@/lib/titles/actions";

export const dynamic = "force-dynamic";

/**
 * 换一个挂着的称号。传 `null` 就是摘下来。
 *
 * ─────────────────────────────────────────
 * `runAsApiCaller` 是这一族写操作的公共壳
 * ─────────────────────────────────────────
 *
 * `equipTitle` 是网页那边用的动作函数，身份从 `getCurrentUser()` 里取。
 * 包一层之后，它在这条路上取到的就是这把令牌背后的账号 ——
 * 而**函数本身一个字没改**，所以称号的持有判定、过期判定、
 * 互斥规则逐字还是网页那一套。
 *
 * 为什么不给它加一个 `user` 参数：见 `lib/api-tokens/as-caller.ts`。
 * 一句话是「一百多个动作各拆一遍，必然有几个把审计或预览态拦截漏掉」。
 */
export async function POST(request: Request) {
  const auth = await authenticate(request, ["me:write"]);
  if (!auth.ok) return auth.response;

  const parsed = await readJson<{ title_id?: unknown }>(request);
  if (!parsed.ok) return parsed.response;

  const titleId = parsed.body.title_id;
  const id = typeof titleId === "string" && titleId ? titleId : null;

  return runAsApiCaller(auth.caller, async () => fromResult(await equipTitle(id)));
}
