import { NextResponse } from "next/server";

import { readAnnouncement, setAnnouncement } from "@/lib/api-tokens/announce";
import { apiError, authenticate } from "@/lib/api-tokens/auth";

export const dynamic = "force-dynamic";

/**
 * 群公告。
 *
 * 这一条在上游加出来之前是**做不到的**，我们的文档里它挂在
 * 「做不到的」那一栏。现在能做了 —— 所以那一栏也一并改掉，
 * 一份说「做不到」而其实做得到的文档，比没有文档更糟：
 * 它会让人根本不去试。
 *
 * 读只要在群里；改要有和发消息同一条授权（理由见 lib/api-tokens/announce.ts）。
 */

export async function GET(
  request: Request,
  { params }: { params: Promise<{ convId: string }> },
) {
  const auth = await authenticate(request, ["groups:read"]);
  if (!auth.ok) return auth.response;

  const convId = decodeURIComponent((await params).convId);
  const result = await readAnnouncement(auth.caller.user, convId);
  if (!result.ok) return apiError(result.status, "not_found", result.error);

  return NextResponse.json({ conv_id: convId, text: result.text });
}

/**
 * ```
 * POST /api/v1/groups/<conv_id>/announcement
 * {"text": "本周六线下"}
 * ```
 *
 * ⚠️ **整条替换**，不是追加 —— 返回体里的 `previous` 是被你顶掉的那一段，
 * 留着它是因为群公告在微信里没有历史版本。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ convId: string }> },
) {
  const auth = await authenticate(request, ["groups:send"]);
  if (!auth.ok) return auth.response;

  const convId = decodeURIComponent((await params).convId);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "bad_request", "请求体不是合法 JSON");
  }

  const result = await setAnnouncement({
    user: auth.caller.user,
    tokenId: auth.caller.tokenId,
    convId,
    text: (body as { text?: unknown })?.text,
  });

  if (!result.ok) {
    return apiError(
      result.status,
      result.status === 429 ? "rate_limited" : "failed",
      result.error,
      result.retryAfterSeconds ? { "Retry-After": String(result.retryAfterSeconds) } : undefined,
    );
  }

  return NextResponse.json({ ok: true, previous: result.previous });
}
