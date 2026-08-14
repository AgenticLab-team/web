import { apiError, authenticate } from "@/lib/api-tokens/auth";
import { runAsApiCaller } from "@/lib/api-tokens/as-caller";
import { fromResult, readJson } from "@/lib/api-tokens/route-helpers";
import { featureEnabled } from "@/lib/flags/server";
import { buyItem } from "@/lib/shop/actions";

export const dynamic = "force-dynamic";

/**
 * 买一件。
 *
 * ═════════════════════════════════════════
 * `client_token` 是**必填**的，它是防重复扣款的全部机制
 * ═════════════════════════════════════════
 *
 * 网页那边这个值由前端生成，用来防「按钮点两下」。在 API 这条路上
 * 它更要紧：脚本会重试，而网络超时之后**重试方根本不知道
 * 上一次到底成没成**。
 *
 * 给它一个默认值（比如现取一个随机数）是最省事的写法，也是最坏的：
 * 那样每次重试都是一个新的幂等键，于是超时重试一次就是扣两次。
 * 而这种错只在网络不好的那天发生，测不出来。
 *
 * 所以宁可让调用方多传一个字段。同一个 token 重发，
 * 拿回的是**同一单**，不是第二单。
 *
 * 库存、限购、等级门槛都在 `buyItem` 里，和网页那条完全一样。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(request, ["economy:write"]);
  if (!auth.ok) return auth.response;

  if (!featureEnabled("shop", auth.caller.user)) {
    return apiError(404, "not_found", "商店没有开");
  }

  const parsed = await readJson<{
    shipping?: unknown;
    target_ref?: unknown;
    client_token?: unknown;
  }>(request);
  if (!parsed.ok) return parsed.response;

  const clientToken = parsed.body.client_token;
  if (typeof clientToken !== "string" || clientToken.length < 8) {
    return apiError(
      400,
      "bad_request",
      "要有 client_token（至少 8 位，自己生成一个随机串）—— 它保证重试不会扣两次",
    );
  }

  const { id } = await params;
  return runAsApiCaller(auth.caller, async () =>
    fromResult(
      await buyItem({
        itemKey: decodeURIComponent(id),
        shipping:
          parsed.body.shipping && typeof parsed.body.shipping === "object"
            ? (parsed.body.shipping as Record<string, unknown>)
            : undefined,
        /* 作用在具体对象上的商品要它 —— 「置顶」要一个帖子 id */
        targetRef: typeof parsed.body.target_ref === "string" ? parsed.body.target_ref : undefined,
        clientToken,
      }),
    ),
  );
}
