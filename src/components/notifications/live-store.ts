"use client";

import { useSyncExternalStore } from "react";

/**
 * 客户端的未读数小仓库。
 *
 * 角标散在侧边栏和底部 Tab Bar 两处，SSE 连接却只有一条（LiveNotifications）。
 * 用 Context 得把 Provider 塞进服务端渲染的 AppShell 组件树里搅一遍；
 * 一个模块级 store + useSyncExternalStore 十行搞定，还天然跨组件树。
 *
 * null 表示「实时通道还没给过数」—— 此时角标继续用服务端渲染的初始值。
 * 不能用 0 当初始：那会在水合的一瞬间把有未读的角标闪没。
 */

let unread: number | null = null;
const listeners = new Set<() => void>();

export function setLiveUnread(n: number): void {
  if (unread === n) return;
  unread = n;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLiveUnread(): number | null {
  // 服务端快照恒为 null —— 水合前后必须一致，否则 React 会警告并重渲
  return useSyncExternalStore(subscribe, () => unread, () => null);
}
