import { NextResponse } from "next/server";

import { apiError, authenticate } from "@/lib/api-tokens/auth";
import { runAsApiCaller } from "@/lib/api-tokens/as-caller";
import { fromResult, paging, param, readJson } from "@/lib/api-tokens/route-helpers";
import { setPitchAction } from "@/lib/github/actions";
import { projectDirectory } from "@/lib/github/projects";
import { githubEnabled } from "@/lib/github/secret";

export const dynamic = "force-dynamic";

/**
 * 项目目录。
 *
 * 要登录才看得到：这一页把「站内某个人」和「某个 GitHub 账号」
 * 摆在同一行上 —— 仓库本来就在 GitHub 上公开着，
 * 但**那条对应关系是这个站拼出来的**。
 */
export async function GET(request: Request) {
  const auth = await authenticate(request, ["community:read"]);
  if (!auth.ok) return auth.response;

  if (!githubEnabled()) {
    /*
     * 没配 GitHub OAuth 应用的话，整个功能不存在 —— 404 而不是空列表。
     * 「半套配置比没配置更糟」：一个空目录会让人以为
     * 这个社区没有人写代码。
     */
    return apiError(404, "not_found", "这个站没有开 GitHub 相关功能");
  }

  const { limit } = paging(request, 100);
  return NextResponse.json({
    projects: projectDirectory({
      language: param(request, "language") ?? undefined,
      sort: (param(request, "sort") ?? undefined) as never,
      limit,
    }),
  });
}

/**
 * 自荐一个项目 —— 给自己已绑定的仓库写一句介绍。
 *
 * 它要的是 `me:write` 而不是 `community:read`：改的是**我自己的**
 * 那一行，不是往目录里塞别人的东西。
 */
export async function POST(request: Request) {
  const auth = await authenticate(request, ["me:write"]);
  if (!auth.ok) return auth.response;

  if (!githubEnabled()) {
    return apiError(404, "not_found", "这个站没有开 GitHub 相关功能");
  }

  const parsed = await readJson<{ repo?: unknown; pitch?: unknown }>(request);
  if (!parsed.ok) return parsed.response;

  const { repo, pitch } = parsed.body;
  if (typeof repo !== "string" || typeof pitch !== "string") {
    return apiError(400, "bad_request", "要有 repo（owner/name）和 pitch");
  }

  return runAsApiCaller(auth.caller, async () => fromResult(await setPitchAction(repo, pitch)));
}
