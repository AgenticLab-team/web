import { NextResponse } from "next/server";

import { apiError, authenticate } from "@/lib/api-tokens/auth";
import { readJson } from "@/lib/api-tokens/route-helpers";
import { makeupState, redeemMakeupCard } from "@/lib/points/makeup";

export const dynamic = "force-dynamic";

/**
 * 用一张补签卡补上某一天。
 *
 * ─────────────────────────────────────────
 * 它归 `economy:write`，不归 `me:write`
 * ─────────────────────────────────────────
 *
 * 补签卡是花积分买来的，用掉就没了。而 `me:write` 那一档里的东西
 * （改昵称、开关隐私）都是**可以改回来的**。
 *
 * 把这两类混在一个 scope 里，等于让一个「只想让脚本帮我改个简介」
 * 的人顺手把「花掉我的东西」也授了出去。
 */
export async function POST(request: Request) {
  const auth = await authenticate(request, ["economy:write"]);
  if (!auth.ok) return auth.response;

  const parsed = await readJson<{ date?: unknown }>(request);
  if (!parsed.ok) return parsed.response;

  const date = parsed.body.date;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return apiError(400, "bad_request", "date 要是 YYYY-MM-DD");
  }

  const result = redeemMakeupCard(auth.caller.user, date);
  if (!result.ok) return apiError(400, "rejected", result.error ?? "补不了这一天");

  return NextResponse.json({ ok: true, makeup: makeupState(auth.caller.user) });
}
