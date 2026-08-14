import { getCurrentUser } from "@/lib/auth/session";
import { readAttachment } from "@/lib/mail/attachment-store";

export const dynamic = "force-dynamic";

/**
 * 网页上的附件下载。
 *
 * ─────────────────────────────────────────
 * 为什么和 `/api/v1/...` 那条分开
 * ─────────────────────────────────────────
 *
 * 那条认的是 API 令牌（`Authorization: Bearer`），而浏览器点一个
 * `<a download>` 是带不上自定义头的 —— 它只会带 cookie。
 *
 * 把两种认证塞进一个路由是能做到的，代价是那个路由要回答
 * 「这次请求算 API 调用还是网页操作」，而那个判断会渗进限流、
 * 留痕、错误格式每一处。两条路各自只认一种身份，反而简单。
 *
 * **取内容那一步是同一个函数**（`readAttachment`），
 * 所以归属校验只有一份 —— 那才是真正不能有第二份的东西。
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return new Response("请先登录", { status: 401 });

  const { id } = await params;
  const file = readAttachment({ userId: user.id, attachmentId: id });
  if (!file) return new Response("没有这个附件", { status: 404 });

  return new Response(new Uint8Array(file.content), {
    headers: {
      // 一律强制下载、一律 octet-stream —— 理由见 v1 那条路由
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${file.filename.replace(/["\\\r\n]/g, "_")}"`,
      "Content-Length": String(file.size),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
