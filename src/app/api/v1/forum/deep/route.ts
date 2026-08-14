import { NextResponse } from "next/server";

import { authenticate } from "@/lib/api-tokens/auth";
import { forumGate } from "@/lib/forum/api-gate";
import { paging } from "@/lib/api-tokens/route-helpers";
import { buildViewerContext } from "@/lib/forum/context";
import { listPosts } from "@/lib/forum/queries";

export const dynamic = "force-dynamic";

/**
 * 深潜：值得慢慢读的长文。
 *
 * 取的判据是**内容形态**，不是作者选的分类 —— 站长标过精华的，
 * 或者正文够长的，不管它发在哪个版块。
 *
 * 这一页存在的理由是数出来的：全站长文平均 2.3 次浏览，
 * 短帖平均 8.2 次。写一天的东西不该比写四秒的东西少人看。
 *
 * 两条列表和网页那一页取的是同一批帖子的两种看法：
 * 「近期」按 deep 排（按天衰减），「更早的」按时间排 ——
 * 后者是给错过了的人准备的，一篇三个月前的好文
 * 在任何按热度排的列表里都不会再出现，而它并没有过期。
 */
export async function GET(request: Request) {
  const auth = await authenticate(request, ["forum:read"]);
  if (!auth.ok) return auth.response;

  const gate = forumGate(auth.caller.user);
  if (gate) return gate;

  const viewer = buildViewerContext(auth.caller.user);
  const { limit } = paging(request, 50);

  const featured = listPosts(viewer, { sort: "deep", longformOnly: true, limit: 11 });
  const seen = new Set(featured.map((p) => p.id));
  const older = listPosts(viewer, { sort: "created", longformOnly: true, limit })
    .filter((p) => !seen.has(p.id));

  return NextResponse.json({ featured, older });
}
