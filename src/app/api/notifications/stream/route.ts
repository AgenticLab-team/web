import type { NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import {
  listSince,
  subscribeLive,
  unreadCountOf,
  type LiveNotification,
} from "@/lib/notifications/live";

/**
 * 通知的 SSE 流。选型理由见 src/lib/notifications/live.ts 头部。
 *
 * ─────────────────────────────────────────
 * 断线补漏是这条路由的全部难点
 * ─────────────────────────────────────────
 *
 * 微信内置浏览器切后台就掐长连接，回到前台 EventSource 自动重连。
 * 重连**必须**把断线期间的动静补上 —— 只从当前时刻往后收的话，
 * 切走的那两分钟里被 @ 的人永远不知道，他会以为自己没被 @。
 * 漏掉的通知比没有通知更糟：它教会用户不信任这个通道。
 *
 * 补漏的挂点有两级：
 *   1. 每个事件的 SSE `id:` 设为该行的 updatedAt。EventSource 重连时
 *      自动带 Last-Event-ID 头，服务端从那一刻起回放 —— 协议自带，零客户端代码。
 *   2. 整页被杀（微信最常见）时 Last-Event-ID 也没了，客户端把游标
 *      存在 localStorage，首连用 ?cursor= 带上 —— 跨页面加载的补漏。
 *
 * 回放用 `>=`（含端点）：客户端游标是最后一条的 updatedAt，同一毫秒
 * 可能还有没见过的行；漏发无法补救，所以宁可在边界上重发。
 *
 * 边界那一条的去重**不能靠客户端**：它的 seen 集合只活在内存里，
 * 整页重新加载就没了，于是同一条通知每刷新一次就再弹一次。
 * 去重的真值是服务端的 readAt —— listSince 只回未读，见 live.ts。
 *
 * 连接最长 15 分钟主动断开：单台小服务器上，被网络中间层僵死的连接
 * 会一直占着订阅表；主动断开后客户端无感重连，成本是每 15 分钟一次握手。
 */

export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 25_000;
const MAX_STREAM_MS = 15 * 60_000;
/** 一次回放的上限。断了一个月的游标不该在重连瞬间灌回几千条 */
const REPLAY_LIMIT = 100;

const encoder = new TextEncoder();

function sse(event: string, data: unknown, id?: number): Uint8Array {
  const head = id === undefined ? "" : `id: ${id}\n`;
  return encoder.encode(`${head}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return new Response("未登录", { status: 401 });

  // Last-Event-ID 是重连（EventSource 自动带），cursor 是冷启动（localStorage）；
  // 前者优先：它一定比页面存的新
  const raw = request.headers.get("last-event-id") ?? request.nextUrl.searchParams.get("cursor");
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

      // 比 EventSource 默认值更积极的重连：这套系统的意义就是快
      write(encoder.encode("retry: 3000\n\n"));

      /*
       * sync 先行：角标立刻正确，且给首次连接的客户端一个起始游标 ——
       * 没有它，第一次断线重连就没有「从哪补」的概念。
       */
      write(sse("sync", { unread: unreadCountOf(user.id), cursor: Date.now() }));

      if (cursor !== null) {
        for (const item of listSince(user.id, cursor, REPLAY_LIMIT)) {
          // replay 标记让客户端把成片的补漏折叠成一条提示，而不是弹一屏幕吐司
          write(sse("notification", { ...item, replay: true }, item.updatedAt));
        }
      }

      const unsubscribe = subscribeLive(
        user.id,
        (item: LiveNotification) => write(sse("notification", { ...item, replay: false }, item.updatedAt)),
        // 连接数超限被挤掉：干净关闭，客户端会重连并顶掉更旧的
        () => close(),
      );

      // 心跳穿透中间层的空闲超时（nginx/微信的代理都会掐安静的连接）
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
