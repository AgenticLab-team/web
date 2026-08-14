import { NextResponse } from "next/server";

import { authenticate } from "@/lib/api-tokens/auth";
import { paging, param } from "@/lib/api-tokens/route-helpers";
import { memberDirectory } from "@/lib/members/queries";

export const dynamic = "force-dynamic";

/**
 * 成员目录。
 *
 * ═════════════════════════════════════════
 * 它只列**和你有共同群**的人
 * ═════════════════════════════════════════
 *
 * 这个站所有的可见性判定都以「你们有没有共同的群」为准，
 * 而这一条是最容易被写成「列出全部用户」的地方 ——
 * `users` 表就在那儿，`select().from(users)` 一行就够了。
 *
 * 那样写的后果是：一个只在一个群里的人，能拿到全站一千多人的名单。
 * 所以走 `memberDirectory(user, …)`，收口在那里面。
 *
 * `facets`（技能标签的分布）也一起给：终端里那是筛选栏，
 * 而它必须是「和你同群的人里」的分布 —— 全站分布本身
 * 就泄露了别的群里有什么人。
 */
export async function GET(request: Request) {
  const auth = await authenticate(request, ["community:read"]);
  if (!auth.ok) return auth.response;

  const { query } = paging(request, 200);
  return NextResponse.json(
    memberDirectory(auth.caller.user, {
      q: query || undefined,
      tag: param(request, "tag") ?? undefined,
      sort: (param(request, "sort") ?? undefined) as never,
    }),
  );
}
