import { apiError, authenticate } from "@/lib/api-tokens/auth";
import { readAttachment } from "@/lib/mail/attachment-store";

export const dynamic = "force-dynamic";

/**
 * 下载一个附件。
 *
 * ─────────────────────────────────────────
 * `Content-Disposition: attachment`，而且**永远不内联**
 * ─────────────────────────────────────────
 *
 * 这是一份陌生人发来的文件。让浏览器内联渲染它（`inline`）意味着
 * 一个 `text/html` 的附件会**在我们的域名下执行**——
 * 那是一个现成的 XSS，而且带着用户的会话 cookie。
 *
 * 所以两件事一起做：强制下载，而且 `Content-Type` 不照抄发件人写的
 * 那个 —— 用 `application/octet-stream`。信任发件人声明的类型，
 * 等于让他决定浏览器怎么处理这个文件。
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authenticate(request, ["mail:burner"]);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const file = readAttachment({ userId: auth.caller.user.id, attachmentId: id });

  // 「不是你的」「不存在」「没存下来」全是 404 —— 见 attachment-store.ts
  if (!file) return apiError(404, "not_found", "没有这个附件");

  return new Response(new Uint8Array(file.content), {
    headers: {
      /*
       * 一律 octet-stream，不照抄发件人写的 mime。
       * 文件名也做了转义：一个叫 `a"; filename="b.exe` 的附件
       * 能把这个头拆成两半。
       */
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${file.filename.replace(/["\\\r\n]/g, "_")}"`,
      "Content-Length": String(file.size),
      // 附件是私人内容 —— 不许被任何中间层缓存
      "Cache-Control": "private, no-store",
      /*
       * 双保险：即便哪天有人把 Content-Disposition 改回 inline，
       * 这一条也让浏览器不去猜类型。
       */
      "X-Content-Type-Options": "nosniff",
    },
  });
}
