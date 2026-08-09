import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { posts } from "@/lib/db/schema";
import { looksLikeShareCode } from "@/lib/forum/share-code";

/**
 * 短链：`/p/<code>` → 那篇帖子。
 *
 * ─────────────────────────────────────────
 * 只做跳转，不自己判可见性
 * ─────────────────────────────────────────
 *
 * 这里**只把短码换成帖子 id**，然后跳到正式地址 ——
 * 权限判定留给那一页。自己再判一遍的话，全站就有了两套可见性逻辑，
 * 而两套迟早分叉；分叉的方向如果是这一条更松，
 * 短链就成了一个绕开权限的后门 —— 而它看起来只是个短地址。
 *
 * 反过来说：**短码不是通行证**。拿到链接的人照样要过那一页的收口，
 * 私密帖依然只有作者和管理员看得到。它换来的只是一个能在微信里
 * 转得动的长度。
 *
 * ─────────────────────────────────────────
 * 认不出来一律 404
 * ─────────────────────────────────────────
 *
 * 不区分「码不对」和「帖子没了」：区分开的话，
 * 这个接口就成了一个可以拿来枚举短码的东西 ——
 * 而枚举的成本正好被短码的长度挡着，不该由我们自己拆掉。
 */
export async function GET(
  request: Request,
  // 不用 `RouteContext<...>`：它从构建产物生成的路由表上取，
  // 而一条新路由还不在那张表里，`tsc` 会在构建之前先报错
  { params }: { params: Promise<{ code: string }> },
) {
  const { code } = await params;

  // 形状先挡一道，省得每个乱敲的路径都查一次库
  if (!looksLikeShareCode(code)) {
    return new Response("Not Found", { status: 404 });
  }

  const row = db
    .select({ id: posts.id })
    .from(posts)
    .where(eq(posts.shareCode, code))
    .get();

  if (!row) return new Response("Not Found", { status: 404 });

  /*
   * 302 而不是 301。
   *
   * 301 会被浏览器和中间层长期缓存 —— 帖子删掉、短码换掉之后，
   * 那条缓存还会把人送到一个已经不存在的地址，而且清不掉。
   * 短链的映射是数据，不是路由结构，不该被当成永久的。
   */
  return Response.redirect(new URL(`/forum/p/${row.id}`, request.url), 302);
}
