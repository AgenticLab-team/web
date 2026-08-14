import { NextResponse } from "next/server";

import { authenticate } from "@/lib/api-tokens/auth";
import { dropDraft } from "@/lib/forum/drafts";

export const dynamic = "force-dynamic";

/**
 * 扔掉一份草稿。
 *
 * `id` 用的是列表里那一行的 `scope`，不是数据库主键 ——
 * 草稿在库里按 (用户, target, scope) 定位，把主键暴露出去
 * 只会多一个需要解释的概念。
 *
 * 删一个不存在的草稿**不报错**：这是给脚本用的接口，
 * 而「让它不存在」这个意图在两种情况下都已经达成了。
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authenticate(request, ["me:write"]);
  if (!auth.ok) return auth.response;

  const scope = decodeURIComponent((await params).id);
  dropDraft(auth.caller.user.id, "post", scope);
  return NextResponse.json({ ok: true });
}
