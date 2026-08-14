import { NextResponse } from "next/server";

import { apiError, authenticate } from "@/lib/api-tokens/auth";
import { runAsApiCaller } from "@/lib/api-tokens/as-caller";
import { fromResult, readJson } from "@/lib/api-tokens/route-helpers";
import { addKeyword } from "@/lib/radar/actions";
import { mySubs } from "@/lib/radar/queries";

export const dynamic = "force-dynamic";

/** 我盯着哪些关键词，以及它们最近命中了什么 */
export async function GET(request: Request) {
  const auth = await authenticate(request, ["groups:read"]);
  if (!auth.ok) return auth.response;
  return NextResponse.json({ keywords: mySubs(auth.caller.user.id) });
}

/**
 * 加一个关键词。
 *
 * ─────────────────────────────────────────
 * 太宽的词会被挡下来，而不是照单收下
 * ─────────────────────────────────────────
 *
 * 一个「的」会在两分钟内命中几百条，然后这个人的通知栏就废了 ——
 * 而他多半会直接关掉整个雷达，而不是回来改那个词。
 *
 * 判定在 `addKeyword` 里，被挡下来时给的是「这个词最近会命中 N 条」，
 * 带上 `force: true` 可以坚持。**先看见数字再决定**，
 * 比先被淹没再后悔好。
 */
export async function POST(request: Request) {
  const auth = await authenticate(request, ["me:write"]);
  if (!auth.ok) return auth.response;

  const parsed = await readJson<{ keyword?: unknown; force?: unknown }>(request);
  if (!parsed.ok) return parsed.response;

  const keyword = parsed.body.keyword;
  if (typeof keyword !== "string" || !keyword.trim()) {
    return apiError(400, "bad_request", "要有 keyword");
  }

  return runAsApiCaller(auth.caller, async () => {
    const result = await addKeyword(keyword, parsed.body.force === true);
    return fromResult(result, { keywords: mySubs(auth.caller.user.id) });
  });
}
