import { NextResponse } from "next/server";

import { apiError, authenticate } from "@/lib/api-tokens/auth";
import { listActivities } from "@/lib/activities/queries";
import { featureEnabled } from "@/lib/flags/server";

export const dynamic = "force-dynamic";

/** 活动列表 */
export async function GET(request: Request) {
  const auth = await authenticate(request, ["community:read"]);
  if (!auth.ok) return auth.response;

  /*
   * 活动是一个可以整体关掉的模块。关掉之后网页那边 404，
   * 而 API 不判的话就成了绕过开关的后门 ——
   * 站长以为关掉了，实际带令牌照样读得到。
   */
  if (!featureEnabled("events", auth.caller.user)) {
    return apiError(404, "not_found", "活动模块没有开");
  }

  return NextResponse.json({ activities: listActivities() });
}
