import { NextResponse } from "next/server";

import { authenticate } from "@/lib/api-tokens/auth";
import { forumGate } from "@/lib/forum/api-gate";
import { paging } from "@/lib/api-tokens/route-helpers";
import { buildViewerContext } from "@/lib/forum/context";
import { searchForum } from "@/lib/forum/search";

export const dynamic = "force-dynamic";

/**
 * 论坛检索。
 *
 * ═════════════════════════════════════════
 * 可见性在 **SQL 层**切掉，不是查出来再过滤
 * ═════════════════════════════════════════
 *
 * `ARCHITECTURE.md` 第五节：**搜索是最容易绕过权限的入口** ——
 * 只要能搜到只言片语，私密内容就已经泄露了。
 *
 * 所以这里不自己拼查询，一律走 `searchForum(viewer, …)`。
 * 自己写一条 SQL 再 filter 的话，「结果里没有」和
 * 「命中数不对」会同时发生，而后者本身就是泄露。
 */
export async function GET(request: Request) {
  const auth = await authenticate(request, ["forum:read"]);
  if (!auth.ok) return auth.response;

  const gate = forumGate(auth.caller.user);
  if (gate) return gate;

  const { query, limit } = paging(request, 50);
  if (!query) {
    // 空查询回空结果而不是全部：一个漏填 q 的脚本不该拉走整个论坛
    return NextResponse.json({ query: "", hits: [] });
  }

  return NextResponse.json({
    query,
    hits: searchForum(buildViewerContext(auth.caller.user), query, limit),
  });
}
