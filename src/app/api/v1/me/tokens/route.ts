import { NextResponse } from "next/server";

import { apiError, authenticate } from "@/lib/api-tokens/auth";
import { runAsApiCaller } from "@/lib/api-tokens/as-caller";
import { readJson } from "@/lib/api-tokens/route-helpers";
import { createTokenAction } from "@/lib/api-tokens/actions";
import { tokensOf } from "@/lib/api-tokens/store";

export const dynamic = "force-dynamic";

/**
 * 我的令牌列表。
 *
 * ─────────────────────────────────────────
 * `source` 是这份列表上最要紧的一列
 * ─────────────────────────────────────────
 *
 * 三类的**泄漏后果完全不同**：
 *
 *   · `manual` 自己建的 —— 在他自己保管的地方
 *   · `device` 本地终端登录换的 —— 在他自己的机器上
 *   · `ssh`   SSH 网关换的 —— **明文躺在一台公开可连的机器上**
 *
 * 混在一张列表里显示的话，最后那一类看起来和前两类一样安全。
 * 所以它单独成组、7 天到期，而且有一个「全撤掉」的口子（见 DELETE）。
 */
export async function GET(request: Request) {
  const auth = await authenticate(request, ["me:read"]);
  if (!auth.ok) return auth.response;

  return NextResponse.json({
    tokens: tokensOf(auth.caller.user.id).map((t) => ({
      ...t,
      /*
       * 当前这一把要标出来。
       *
       * 不标的话，人会在终端里撤销自己正在用的那把 ——
       * 界面上看不出区别，而按下去的后果是当场掉线。
       */
      current: t.id === auth.caller.tokenId,
    })),
  });
}

/**
 * 建一把新令牌。
 *
 * 明文只在这一次返回里出现，之后库里只有哈希 ——
 * 没抄下来就只能重建一把。
 */
export async function POST(request: Request) {
  const auth = await authenticate(request, ["me:write"]);
  if (!auth.ok) return auth.response;

  const parsed = await readJson<{ name?: unknown; scopes?: unknown }>(request);
  if (!parsed.ok) return parsed.response;

  const { name, scopes } = parsed.body;
  if (typeof name !== "string" || !Array.isArray(scopes)) {
    return apiError(400, "bad_request", "要有 name（字符串）和 scopes（数组）");
  }

  return runAsApiCaller(auth.caller, async () => {
    const result = await createTokenAction(
      name,
      scopes.filter((s): s is string => typeof s === "string"),
    );
    if (!result.ok) return apiError(400, "rejected", result.error);
    /*
     * `plaintext` 只在这一次出现。没抄下来就只能重建一把 ——
     * 库里存的是哈希，我们自己也读不出来。
     */
    return NextResponse.json({ ok: true, token: result.plaintext, note: result.note });
  });
}
