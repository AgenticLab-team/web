import { NextResponse } from "next/server";

import { apiError, authenticate } from "@/lib/api-tokens/auth";
import { buildViewerContext } from "@/lib/forum/context";
import { listPosts } from "@/lib/forum/queries";
import { projectHeader } from "@/lib/github/projects";
import { githubEnabled } from "@/lib/github/secret";

export const dynamic = "force-dynamic";

/**
 * 一个项目的详情。
 *
 * ═════════════════════════════════════════
 * owner/repo 只经过 `projectHeader` 一处解析
 * ═════════════════════════════════════════
 *
 * 那里面走的是 `parseRepoRef` —— 全站唯一一处把
 * 「用户给的一串字符」翻译成「一个 GitHub 仓库引用」的地方，
 * 也就是唯一那处安全边界（host 只做全等比较，
 * 见 `lib/github/link-refs.ts` 顶上那段）。
 *
 * 在这里自己拼一个 `${owner}/${repo}` 去查库，等于绕开它。
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ owner: string; repo: string }> },
) {
  const auth = await authenticate(request, ["community:read"]);
  if (!auth.ok) return auth.response;

  if (!githubEnabled()) {
    return apiError(404, "not_found", "这个站没有开 GitHub 相关功能");
  }

  const { owner, repo } = await params;
  const header = projectHeader(decodeURIComponent(owner), decodeURIComponent(repo));
  if (!header) return apiError(404, "not_found", "没有这个项目");

  return NextResponse.json({
    ...header,
    /* 站里提到过它的帖子 —— 这是「项目页」和「GitHub 页」的全部区别 */
    posts: listPosts(buildViewerContext(auth.caller.user), {
      /* 小写化在 listPosts 那侧有约定 —— 传的就是它期望的形状 */
      repoRef: `${owner}/${repo}`.toLowerCase(),
      limit: 20,
    }),
  });
}
