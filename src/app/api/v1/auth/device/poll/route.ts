import { NextResponse } from "next/server";

import { apiError } from "@/lib/api-tokens/auth";
import { pollDevice } from "@/lib/tui/device";

export const dynamic = "force-dynamic";

/**
 * 终端问：批了吗。
 *
 * `/api/v1` 下另一条不过 `authenticate()` 的路由，理由见同目录的
 * `start/route.ts` —— 这一步的目的就是拿到令牌。
 * 两条都在 `tests/api-surface.test.ts` 的放行名单里**列名**登记着。
 *
 * ─────────────────────────────────────────
 * 认的是 `device_code`，不是屏幕上那串
 * ─────────────────────────────────────────
 *
 * 屏幕上那串（`WXYZ-7Q2M`）只有 39 位熵，而且它的使用方式
 * 就是被人念出来。用它换令牌的话，「偷看一眼屏幕」等于「拿到令牌」。
 *
 * `device_code` 是 256 位、从不显示、只在终端进程里。
 * 两者分开之后，偷看屏幕的人最多能替你去点同意 ——
 * 而那需要他有你的账号。
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "bad_json", "请求体不是合法的 JSON");
  }

  const result = pollDevice((body as { device_code?: unknown } | null)?.device_code);

  /*
   * 找不到就当过期。
   *
   * 分开报「这条码不存在」的话，这个接口会变成一个
   * 「某条 device_code 是否存在」的探测器 —— 而它是不需要
   * 任何身份就能调的。
   *
   * 客户端那边两者的处理也完全一样（重新走一遍登录），
   * 所以合并不会让任何人少知道一件他需要知道的事。
   */
  if (!result) {
    return NextResponse.json({ error: "expired_token" }, { status: 400 });
  }

  if (!result.granted) {
    const { outcome } = result;
    return NextResponse.json(
      {
        error: outcome.error,
        ...(outcome.state === "slow_down" ? { interval: outcome.interval } : {}),
      },
      /*
       * `authorization_pending` 用 428（Precondition Required）而不是 200。
       *
       * 200 的话，任何一层中间件（CDN、反代、客户端库的默认重试）
       * 都会把「还没批」当成成功结果缓存或放行 —— 而这条要被
       * 每 5 秒问一次，缓存住的后果是**人在网页上点了同意，
       * 终端永远不知道**。
       *
       * 400 系的状态码没有这个问题，且客户端库不会自作主张重试。
       */
        { status: outcome.state === "slow_down" ? 429 : 428 },
    );
  }

  return NextResponse.json({
    access_token: result.token,
    token_type: "Bearer",
    scopes: result.scopes,
    expires_at: result.expiresAt,
  });
}
