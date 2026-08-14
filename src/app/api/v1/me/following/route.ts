import { NextResponse } from "next/server";

import { apiError, authenticate } from "@/lib/api-tokens/auth";
import { runAsApiCaller } from "@/lib/api-tokens/as-caller";
import { fromResult, readJson } from "@/lib/api-tokens/route-helpers";
import { toggleFollow } from "@/lib/forum/follow-actions";
import { listFollows } from "@/lib/forum/follow";

export const dynamic = "force-dynamic";

/** 我关注了什么（人、帖子、标签、版块） */
export async function GET(request: Request) {
  const auth = await authenticate(request, ["me:read"]);
  if (!auth.ok) return auth.response;
  return NextResponse.json({ follows: listFollows(auth.caller.user.id) });
}

/**
 * 关注 / 取关。
 *
 * `target` 说的是关注**什么类型**（`user` / `post` / `tag` / `board`）——
 * 站里的订阅表本来就是四种共用一张，这里照搬，不另发明一套。
 */
export async function POST(request: Request) {
  const auth = await authenticate(request, ["me:write"]);
  if (!auth.ok) return auth.response;

  const parsed = await readJson<{ target?: unknown; id?: unknown }>(request);
  if (!parsed.ok) return parsed.response;

  const { target, id } = parsed.body;
  if (typeof id !== "string" || !id) {
    return apiError(400, "bad_request", "要有 id");
  }
  const kind = typeof target === "string" ? target : "user";

  /*
   * `toggleFollow` 是切换而不是设置。
   *
   * 对脚本来说这不理想（重试会翻转回去），但**另写一个「设置成 X」
   * 的实现就是第二份规则** —— 而关注这件事上有一堆判定
   * （不能关注自己、被拉黑的关注不了、关注上限）。
   *
   * 折中：返回体里带上切换**之后**的状态，脚本据此判断要不要再来一次。
   */
  return runAsApiCaller(auth.caller, async () => {
    const result = await toggleFollow(kind as never, id);
    return fromResult(result, { following: (result as { following?: boolean }).following });
  });
}
