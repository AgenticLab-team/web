"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { setLiveUnread } from "./live-store";

/**
 * 通知的实时客户端：一条 SSE 连接 + 角标更新 + 轻量吐司。
 *
 * ─────────────────────────────────────────
 * 微信内置浏览器是这里所有奇怪代码的原因
 * ─────────────────────────────────────────
 *
 * 它切后台就冻结页面、掐长连接，回到前台有时恢复有时不恢复。
 * 应对分三层：
 *   1. EventSource 自带断线重连，且自动带 Last-Event-ID —— 服务端
 *      据此回放断线期间漏掉的（见 /api/notifications/stream）。
 *   2. 连接被服务端正常关闭（15 分钟到期）或彻底失败时 EventSource
 *      不再自己重试，这里手动指数退避重建。
 *   3. 整页被杀再进（微信最常见）连 Last-Event-ID 都没了：游标存
 *      localStorage，重建连接时用 ?cursor= 补上 —— 跨页面加载的补漏。
 *
 * 补漏回放的事件带 replay 标记：断了十分钟的人回来不该被十条吐司
 * 糊一脸，折叠成一条「离线期间有 N 条」；角标用服务端算好的绝对值，
 * 事件重复到达也不会数错。
 */

const CURSOR_KEY = "al:ntf:cursor";
const TOAST_MS = 6_000;
const MAX_TOASTS = 3;

interface LiveEvent {
  id: string;
  title: string;
  link: string | null;
  updatedAt: number;
  unread: number;
  replay: boolean;
}

interface Toast {
  key: string;
  title: string;
  link: string;
}

function readCursor(): number | null {
  try {
    const n = Number(localStorage.getItem(CURSOR_KEY));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function writeCursor(value: number): void {
  try {
    const prev = readCursor();
    // 游标只往前走 —— 回放的旧事件不能把它拽回去，否则每次重连回放越来越长
    if (prev === null || value > prev) localStorage.setItem(CURSOR_KEY, String(value));
  } catch {
    /* 隐私模式下 localStorage 会抛，退化成「每次都只从现在开始」 */
  }
}

export function LiveNotifications() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const router = useRouter();
  const pathname = usePathname();
  // 连接的生命周期不能跟着 pathname 变（重连会丢 Last-Event-ID 语境），
  // 事件处理里又需要读到最新路径 —— 用 ref 解耦，在 effect 里更新
  const pathnameRef = useRef(pathname);
  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  useEffect(() => {
    let es: EventSource | null = null;
    let stopped = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryDelay = 3_000;
    let replayBuffer = 0;
    let replayFlush: ReturnType<typeof setTimeout> | null = null;
    // 同一条通知的同一次变更只提示一次 —— >= 游标回放在边界上会重发一条
    const seen = new Set<string>();

    const pushToast = (toast: Toast) => {
      setToasts((prev) => [...prev.slice(-(MAX_TOASTS - 1)), toast]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.key !== toast.key));
      }, TOAST_MS);
    };

    const scheduleReconnect = () => {
      if (stopped || retryTimer) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        connect();
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 60_000);
    };

    const connect = () => {
      if (stopped) return;
      es?.close();
      const cursor = readCursor();
      es = new EventSource(
        `/api/notifications/stream${cursor ? `?cursor=${cursor}` : ""}`,
      );

      es.addEventListener("open", () => {
        retryDelay = 3_000;
      });

      es.addEventListener("sync", (e) => {
        const data = JSON.parse((e as MessageEvent).data) as { unread: number; cursor: number };
        setLiveUnread(data.unread);
        // 第一次连上才记起点；已有游标的不动 —— sync 的 cursor 是「现在」，会吃掉待回放的区间
        if (readCursor() === null) writeCursor(data.cursor);
      });

      es.addEventListener("notification", (e) => {
        const data = JSON.parse((e as MessageEvent).data) as LiveEvent;
        setLiveUnread(data.unread);
        writeCursor(data.updatedAt);

        const dedupeKey = `${data.id}:${data.updatedAt}`;
        if (seen.has(dedupeKey)) return;
        seen.add(dedupeKey);
        if (seen.size > 500) seen.clear();

        // 正在看通知页就直接刷新列表 —— 吐司叠在列表上是重复打扰
        if (pathnameRef.current.startsWith("/notifications")) {
          router.refresh();
          return;
        }

        if (data.replay) {
          replayBuffer += 1;
          if (replayFlush) clearTimeout(replayFlush);
          replayFlush = setTimeout(() => {
            const n = replayBuffer;
            replayBuffer = 0;
            pushToast({
              key: `replay:${Date.now()}`,
              title: n === 1 ? data.title : `离线期间有 ${n} 条新通知`,
              link: n === 1 ? (data.link ?? "/notifications") : "/notifications",
            });
          }, 300);
          return;
        }

        pushToast({
          key: dedupeKey,
          title: data.title,
          link: data.link ?? "/notifications",
        });
      });

      es.onerror = () => {
        /*
         * readyState 还是 CONNECTING 时 EventSource 会自己带着
         * Last-Event-ID 重试，不要插手；只有 CLOSED（服务端到期关闭、
         * 401、被挤掉）才需要我们自己重建。
         */
        if (es && es.readyState === EventSource.CLOSED) {
          es.close();
          scheduleReconnect();
        }
      };
    };

    const onVisible = () => {
      // 微信回前台：连接多半已经死了但对象还在 —— 立刻重建，别等退避计时
      if (document.visibilityState === "visible" && (!es || es.readyState === EventSource.CLOSED)) {
        if (retryTimer) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
        connect();
      }
    };

    connect();
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisible);
      if (retryTimer) clearTimeout(retryTimer);
      if (replayFlush) clearTimeout(replayFlush);
      es?.close();
    };
  }, [router]);

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed inset-x-4 z-50 flex flex-col items-center gap-2 lg:left-auto lg:right-6 lg:w-80"
      style={{ bottom: "calc(var(--tabbar-height, 0px) + 0.75rem)" }}
      role="status"
      aria-live="polite"
    >
      {toasts.map((toast) => (
        <Link
          key={toast.key}
          href={toast.link}
          onClick={() => setToasts((prev) => prev.filter((t) => t.key !== toast.key))}
          className="chrome w-full max-w-96 rounded-[var(--radius-control)] border border-[var(--separator)] px-4 py-3 shadow-lg transition active:opacity-70"
        >
          <span className="t-subhead block truncate">{toast.title}</span>
          <span className="t-caption text-[var(--ink-tertiary)]">点击查看</span>
        </Link>
      ))}
    </div>
  );
}
