import { NextResponse } from "next/server";

import { authenticate } from "@/lib/api-tokens/auth";
import { paging, param } from "@/lib/api-tokens/route-helpers";
import { bookmarkTabs, listBookmarkItems } from "@/lib/forum/bookmark-queries";
import { buildViewerContext } from "@/lib/forum/context";

export const dynamic = "force-dynamic";

/**
 * 收藏夹。
 *
 * 文件夹和条目一起给：终端里这是一屏（左边文件夹、右边条目），
 * 分两条接口的话第一次进来会先闪一个没有文件夹的列表。
 *
 * 走 `listBookmarkItems(viewer, …)` 而不是直接查 `bookmarks` 表：
 * 收藏里可能有**后来被删掉或被收进私密版块的帖子**，
 * 而那一层负责把它们过滤掉。自己查表的话，
 * 收藏夹会成为一个绕过可见性看标题的口子。
 */
export async function GET(request: Request) {
  const auth = await authenticate(request, ["me:read"]);
  if (!auth.ok) return auth.response;

  const { user } = auth.caller;
  const { limit, offset } = paging(request, 100);
  const folder = param(request, "folder");

  return NextResponse.json({
    ...bookmarkTabs(user.id),
    bookmarks: listBookmarkItems(buildViewerContext(user), {
      // `folder=none` 是「未分类」那一档，和「不筛」不是一回事
      folderId: folder === "none" ? null : folder ?? undefined,
      limit,
      offset,
    }),
  });
}
