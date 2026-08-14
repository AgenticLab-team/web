import { NextResponse } from "next/server";

import { apiError, authenticate } from "@/lib/api-tokens/auth";
import { listBurners, openBurner } from "@/lib/mail/burner";
import { burnerPayload } from "@/lib/mail/api-view";
import { can } from "@/lib/rbac/can";

export const dynamic = "force-dynamic";

/**
 * 一次性邮箱的开放 API。
 *
 * 用的是 `mail:burner` 这个 scope，而它**只让令牌看到自己开的箱子** ——
 * `tokenId` 一路传到查询层，不在这里过滤。放在这里过滤的话，
 * 每加一个接口就是一次漏掉它的机会，而漏掉的那次是「别人能读你的验证码」。
 */

/** 列出这把令牌开的、还活着的一次性箱 */
export async function GET(request: Request) {
  const auth = await authenticate(request, ["mail:burner"]);
  if (!auth.ok) return auth.response;

  const boxes = listBurners({
    userId: auth.caller.user.id,
    tokenId: auth.caller.tokenId,
  });

  return NextResponse.json({ burners: boxes.map(burnerPayload) });
}

/**
 * 开一个。
 *
 * `local_part` 不填就随机 —— 而**随机是默认**：脚本里最常见的用法是
 * 「给我一个能收信的地址」，让它先想一个名字是多余的一步。
 */
export async function POST(request: Request) {
  const auth = await authenticate(request, ["mail:burner"]);
  if (!auth.ok) return auth.response;

  let body: { local_part?: unknown; domain?: unknown } = {};
  if (request.headers.get("content-length") !== "0") {
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return apiError(400, "bad_json", "请求体不是 JSON");
    }
  }

  /*
   * 和网页那边同一条口径：能管邮箱的人不受额度限制。
   * 判据是 `mail.box.write` —— 理由写在 `lib/mail/burner-actions.ts` 里。
   *
   * 两处都要判，不能只判一处：只在网页上放开的话，
   * 站长用自己的令牌跑脚本时反而被卡住，而那正是他最需要批量开箱的场合。
   */
  const result = openBurner({
    userId: auth.caller.user.id,
    tokenId: auth.caller.tokenId,
    bypassLimits: can(auth.caller.user, "mail.box.write").allowed,
    localPart: typeof body.local_part === "string" ? body.local_part : null,
    domain: typeof body.domain === "string" ? body.domain : null,
  });

  if (!result.ok) {
    /*
     * 限流和「用光了」报 429，别的报 400。
     *
     * 混成一个的话，脚本作者会把「等一会儿就好」的情况
     * 当成「我传错了参数」，然后去改一个没有问题的参数。
     */
    const status = result.code === "rate_limit" || result.code === "concurrent_limit" ? 429 : 400;
    return apiError(status, result.code, result.error);
  }

  return NextResponse.json(burnerPayload(result.box), { status: 201 });
}
