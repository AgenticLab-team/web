import { NextResponse } from "next/server";

import { authenticate } from "@/lib/api-tokens/auth";
import { paging, param } from "@/lib/api-tokens/route-helpers";
import { listLinks } from "@/lib/links/queries";

export const dynamic = "force-dynamic";

/**
 * 资源库：群里贴过的链接。
 *
 * 走 `listLinks(user, …)`：它把「被分享次数」按**你看得到的群**
 * 重新数了一遍。直接读 `links.share_count` 的话，一条只在别的群
 * 火过的链接会显示「被分享 12 次」，而你在自己的群里从没见过它。
 */
export async function GET(request: Request) {
  const auth = await authenticate(request, ["groups:read"]);
  if (!auth.ok) return auth.response;

  const { limit, query } = paging(request, 50);
  return NextResponse.json(
    listLinks(auth.caller.user, {
      q: query || undefined,
      sort: (param(request, "sort") ?? undefined) as never,
      domain: param(request, "domain") ?? undefined,
      savedOnly: param(request, "saved") === "1",
      limit,
    }),
  );
}
