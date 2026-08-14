import { NextResponse } from "next/server";

import { apiError, authenticate } from "@/lib/api-tokens/auth";
import { readJson } from "@/lib/api-tokens/route-helpers";
import { db } from "@/lib/db";
import { boards } from "@/lib/db/schema";
import { listDrafts, saveDraft } from "@/lib/forum/drafts";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

/** 草稿箱 */
export async function GET(request: Request) {
  const auth = await authenticate(request, ["me:read"]);
  if (!auth.ok) return auth.response;
  return NextResponse.json({ drafts: listDrafts(auth.caller.user.id) });
}

/**
 * 存一份草稿。
 *
 * ═════════════════════════════════════════
 * `base` 是**必填**，它是防覆盖的全部机制
 * ═════════════════════════════════════════
 *
 * 草稿会被两处同时写：网页上的编辑器和终端里的编辑器。
 * 不带版本号的话，后到的那次无条件覆盖 ——
 * 而「后到」和「后写的」不是一回事：网络慢的那一端可能写得更早。
 *
 * 结果是人在终端里敲了半天，切到网页刷新一下就没了，
 * 而两边都没有任何提示。
 *
 * 所以要带上「我是基于哪一版改的」。第一次存传 0。
 */
export async function POST(request: Request) {
  const auth = await authenticate(request, ["me:write"]);
  if (!auth.ok) return auth.response;

  const parsed = await readJson<{
    board?: unknown;
    title?: unknown;
    content?: unknown;
    scope?: unknown;
    base?: unknown;
  }>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  if (typeof body.content !== "string") {
    return apiError(400, "bad_request", "要有 content");
  }

  const boardKey = typeof body.board === "string" ? body.board : null;
  const board = boardKey
    ? db.select({ id: boards.id }).from(boards).where(eq(boards.key, boardKey)).get()
    : null;

  const result = saveDraft({
    userId: auth.caller.user.id,
    target: "post",
    /*
     * `scope` 区分「同时在写的几份草稿」：发新帖用版块 key，
     * 回帖用帖子 id。不传就是那个版块的新帖草稿。
     */
    scope: typeof body.scope === "string" && body.scope ? body.scope : (boardKey ?? "new"),
    boardId: board?.id ?? null,
    title: typeof body.title === "string" ? body.title : null,
    content: body.content,
    base: typeof body.base === "number" ? body.base : 0,
  });

  if (!result.ok) return apiError(409, "conflict", result.reason ?? "存不下");
  return NextResponse.json({ ...result, ok: true });
}
