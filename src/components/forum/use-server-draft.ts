"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  SERVER_SAVE_INTERVAL_MS,
  type DraftSnapshot,
  type DraftTarget,
} from "@/lib/forum/draft-rules";

/**
 * 把编辑器里的内容同步到服务端。
 *
 * ─────────────────────────────────────────
 * 页面被杀掉的那一刻才是重点
 * ─────────────────────────────────────────
 *
 * 微信内置浏览器随时回收页面。所以除了定时保存，
 * 还要在 `visibilitychange → hidden` 时用 `sendBeacon` 再存一次 ——
 * 那是「切出去回条消息」和「被系统杀掉」共同的第一个信号。
 *
 * 用 `pagehide` 而不是 `beforeunload`：iOS Safari 与微信 webview
 * 在被回收时**不触发 beforeunload**，而那正是这里要救的场景。
 */

export interface ServerDraftState {
  /** 服务端上那份比本地新，还没决定用哪个 */
  conflict: DraftSnapshot | null;
  savedAt: number | null;
  saving: boolean;
}

export function useServerDraft(input: {
  target: DraftTarget;
  scope: string;
  boardId?: string | null;
  title?: string | null;
  content: string;
  /** 服务端渲染时读到的那份，用来定 base */
  serverUpdatedAt: number | null;
  enabled?: boolean;
}) {
  const { target, scope, boardId, title, content, serverUpdatedAt, enabled = true } = input;

  const [state, setState] = useState<ServerDraftState>({
    conflict: null,
    savedAt: null,
    saving: false,
  });

  /*
   * base、最后存过什么、以及当前内容都放 ref。
   *
   * 放 state 的话，每 10 秒一次的保存会把整棵编辑器重渲染一遍 ——
   * 而人正在里面打字。ref 变了不触发渲染，正是这里要的。
   */
  const baseRef = useRef(serverUpdatedAt ?? 0);
  const lastSentRef = useRef<string | null>(null);
  const payloadRef = useRef({ target, scope, boardId, title, content });

  /*
   * 在 effect 里同步，不在渲染里写 ref。
   *
   * 渲染期间写 ref 在并发渲染下不安全（一次被丢弃的渲染也会把它改掉）。
   * effect 在这一帧提交后就跑，而这里最快的读取方（10 秒一次的定时保存
   * 和 pagehide）都在那之后很久 —— 差这一帧读不出来。
   */
  useEffect(() => {
    payloadRef.current = { target, scope, boardId, title, content };
  }, [target, scope, boardId, title, content]);

  const bodyOf = useCallback(() => {
    const p = payloadRef.current;
    return JSON.stringify({
      target: p.target,
      scope: p.scope,
      boardId: p.boardId ?? null,
      title: p.title ?? null,
      content: p.content,
      base: baseRef.current,
    });
  }, []);

  /** 定时保存走 fetch —— 要看响应（冲突、新的 updatedAt） */
  const save = useCallback(async () => {
    const body = bodyOf();
    if (body === lastSentRef.current) return; // 没变就不发

    setState((s) => ({ ...s, saving: true }));
    try {
      const response = await fetch("/api/forum/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      const data = await response.json().catch(() => ({}));

      if (response.status === 409) {
        // 别把 lastSent 记下来 —— 人选完之后这次内容还要能再存一遍
        setState({ conflict: data.server ?? null, savedAt: null, saving: false });
        return;
      }
      if (!response.ok) {
        setState((s) => ({ ...s, saving: false }));
        return;
      }

      lastSentRef.current = body;
      if (typeof data.updatedAt === "number") baseRef.current = data.updatedAt;
      // 删掉之后 base 归零，否则下次保存会拿着一个已经不存在的版本号
      if (data.discarded) baseRef.current = 0;
      setState({ conflict: null, savedAt: Date.now(), saving: false });
    } catch {
      setState((s) => ({ ...s, saving: false }));
    }
  }, [bodyOf]);

  useEffect(() => {
    if (!enabled || !scope) return;
    const id = setInterval(save, SERVER_SAVE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [enabled, scope, save]);

  useEffect(() => {
    if (!enabled || !scope) return;

    /*
     * 页面要没了 —— 用 beacon 抢最后一次。
     *
     * beacon 拿不到响应，所以这一次可能撞上冲突而我们不会知道。
     * 那是可以接受的：服务端仍然会拒绝覆盖更新的版本，
     * 最坏情况是这一次没存上，而不是盖掉别的设备写的东西。
     */
    const flush = () => {
      const body = bodyOf();
      if (body === lastSentRef.current) return;
      navigator.sendBeacon?.(
        "/api/forum/draft",
        new Blob([body], { type: "application/json" }),
      );
      lastSentRef.current = body;
    };

    const onHidden = () => {
      if (document.visibilityState === "hidden") flush();
    };

    document.addEventListener("visibilitychange", onHidden);
    // pagehide 而不是 beforeunload：iOS 与微信 webview 被回收时不触发后者
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", flush);
    };
  }, [enabled, scope, bodyOf]);

  /** 人选了「用服务器那份」之后，把 base 对齐，免得下一次保存又冲突 */
  const acceptServer = useCallback((snapshot: DraftSnapshot) => {
    baseRef.current = snapshot.updatedAt;
    lastSentRef.current = null;
    setState((s) => ({ ...s, conflict: null }));
  }, []);

  /** 人选了「用我这份」—— 以服务器那份为基准强行盖过去 */
  const keepMine = useCallback(
    (serverUpdatedAt: number) => {
      baseRef.current = serverUpdatedAt;
      lastSentRef.current = null;
      setState((s) => ({ ...s, conflict: null }));
      void save();
    },
    [save],
  );

  return { ...state, save, acceptServer, keepMine };
}
