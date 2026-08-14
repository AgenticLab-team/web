import { authenticate } from "@/lib/api-tokens/auth";
import { listSince, subscribeLive, unreadCountOf, type LiveNotification } from "@/lib/notifications/live";

export const dynamic = "force-dynamic";

/**
 * 通知的实时流，令牌版。
 *
 * ═════════════════════════════════════════
 * 为什么不复用 `/api/notifications/stream`
 * ═════════════════════════════════════════
 *
 * 那一条走 cookie 会话（`getCurrentUser()` 直接读 cookie），
 * 而这条路上没有 cookie —— 也**不能有**：让令牌走进那条路，
 * 或者让 cookie 走进这条路，都是 `lib/api-tokens/auth.ts`
 * 顶上明写着不许的。
 *
 * 两条路由，一份实现：补漏、心跳、超时全在 `lib/notifications/live.ts`
 * 里，这里和那里都只是把它翻译成一个 HTTP 响应。
 *
 * ─────────────────────────────────────────
 * 断线补漏是这条路由的全部难点（和网页那条一样）
 * ─────────────────────────────────────────
 *
 * 终端会被 SIGTSTP 挂起、会被 SSH 断线、会被人合上笔记本。
 * 重连之后**必须**把断线期间的动静补上 —— 只从当前时刻往后收的话，
 * 那段时间里被 @ 的人永远不知道。
 *
 * **漏掉的通知比没有通知更糟：它教会人不信任这个通道。**
 *
 * 挂点是 SSE 的 `id:`（客户端重连自动带 `Last-Event-ID`）
 * 加上一个 `?cursor=`（进程重启之后，从本地存的游标接上）。
 */
const HEARTBEAT_MS = 25_000;
const MAX_STREAM_MS = 15 * 60_000;
/** 一次回放的上限。断了一个月的游标不该在重连瞬间灌回几千条 */
const REPLAY_LIMIT = 100;

const encoder = new TextEncoder();

function sse(event: string, data: unknown, id?: number): Uint8Array {
  const head = id === undefined ? "" : `id: ${id}\n`;
  return encoder.encode(`${head}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function GET(request: Request) {
  const auth = await authenticate(request, ["notifications:read"]);
  if (!auth.ok) return auth.response;

  const userId = auth.caller.user.id;
  const url = new URL(request.url);
  const raw = request.headers.get("last-event-id") ?? url.searchParams.get("cursor");
  const parsed = Number(raw);
  const cursor = Number.isFinite(parsed) && parsed > 0 ? parsed : null;

  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const write = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          // 对端已断开而 abort 事件尚未到达 —— 立即收尾，别再往黑洞里写
          close();
        }
      };

      write(encoder.encode("retry: 3000\n\n"));
      // sync 先行：角标立刻正确，也给首次连接一个起始游标
      write(sse("sync", { unread: unreadCountOf(userId), cursor: Date.now() }));

      if (cursor !== null) {
        for (const item of listSince(userId, cursor, REPLAY_LIMIT)) {
          // replay 标记让客户端把成片的补漏折叠成一条提示，而不是刷一屏
          write(sse("notification", { ...item, replay: true }, item.updatedAt));
        }
      }

      const unsubscribe = subscribeLive(
        userId,
        (item: LiveNotification) => write(sse("notification", { ...item, replay: false }, item.updatedAt)),
        () => close(),
      );

      const heartbeat = setInterval(() => write(encoder.encode(": ping\n\n")), HEARTBEAT_MS);
      const deadline = setTimeout(() => close(), MAX_STREAM_MS);

      function close() {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clearTimeout(deadline);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* 已经关了 */
        }
      }

      cleanup = close;
      request.signal.addEventListener("abort", close);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      // 反代若开了响应缓冲，事件会攒到断开才一次性到达 —— 等于没有实时
      "X-Accel-Buffering": "no",
    },
  });
}
