import { NextResponse } from "next/server";

import { authenticate } from "@/lib/api-tokens/auth";
import { readJson } from "@/lib/api-tokens/route-helpers";
import { markRead, notificationCounts } from "@/lib/forum/notify";

export const dynamic = "force-dynamic";

/**
 * 标记已读。不带 `ids` 就是全部。
 *
 * ─────────────────────────────────────────
 * 它只要 `notifications:write`，而那一档**读不到内容**
 * ─────────────────────────────────────────
 *
 * 这是分两个 scope 的全部意义：一个「帮我清红点」的脚本
 * 不需要看见任何一条通知里写了什么。
 */
export async function POST(request: Request) {
  const auth = await authenticate(request, ["notifications:write"]);
  if (!auth.ok) return auth.response;

  const parsed = await readJson<{ ids?: unknown }>(request);
  if (!parsed.ok) return parsed.response;

  const { user } = auth.caller;
  const ids = parsed.body.ids;

  /*
   * ─────────────────────────────────────────
   * 空数组是「一条都不标」，不是「全部」
   * ─────────────────────────────────────────
   *
   * 把两者合并成「全部」很省事，但它会咬人：一个写成
   * `ids: list.filter(想标的)` 的脚本，在没有未读的那天发出空数组，
   * 而它期望的是「什么也别做」。合并的话那一次会把**所有**通知
   * 标成已读 —— 包括他刚刚故意留着的那几条。
   *
   * 未读状态是留不住的：标错了没有撤销。所以宁可让
   * 「我要全标」必须显式地不传这个字段。
   */
  if (Array.isArray(ids)) {
    for (const id of ids) if (typeof id === "string") markRead(user.id, id);
  } else {
    markRead(user.id);
  }

  return NextResponse.json({ ok: true, counts: notificationCounts(user.id) });
}
