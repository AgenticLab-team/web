"use client";

import type { DraftSnapshot } from "@/lib/forum/draft-rules";

/**
 * localStorage 里那份草稿。
 *
 * ─────────────────────────────────────────
 * 为什么要带时间戳
 * ─────────────────────────────────────────
 *
 * 原来存的是一个裸字符串。加了服务端草稿之后，
 * 「本地这份和服务器那份哪个新」就必须回答得出来 ——
 * 而一个没有时间的字符串回答不了。
 *
 * ─────────────────────────────────────────
 * 老格式要认
 * ─────────────────────────────────────────
 *
 * 换格式那一刻，已经在别人浏览器里躺着的草稿是裸字符串。
 * 不认的话，这次改动会**当场吞掉所有人正在写的东西** ——
 * 一次为了保住草稿而做的改动，第一件事是把草稿全弄丢。
 *
 * 老格式没有时间，给 0：它一定"最旧"，于是服务器上那份会赢，
 * 而那正是这种情况下更安全的一边。
 */

interface Stored {
  v: string;
  t: number;
}

const KEY = (key: string) => `draft:${key}`;

export function readLocalDraft(key: string): DraftSnapshot | null {
  if (typeof localStorage === "undefined") return null;

  const raw = localStorage.getItem(KEY(key));
  if (!raw) return null;

  // 老格式：裸字符串，不是 JSON
  if (!raw.startsWith("{")) {
    return raw.trim() ? { content: raw, title: null, updatedAt: 0 } : null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<Stored>;
    if (typeof parsed.v !== "string" || !parsed.v.trim()) return null;
    return { content: parsed.v, title: null, updatedAt: typeof parsed.t === "number" ? parsed.t : 0 };
  } catch {
    /*
     * 存进去的时候是合法 JSON，读出来不是 —— 多半是被别的东西写坏了。
     * 当成裸字符串再试一次，而不是丢掉：这里的默认动作永远是**保住内容**。
     */
    return raw.trim() ? { content: raw, title: null, updatedAt: 0 } : null;
  }
}

export function writeLocalDraft(key: string, value: string, now = Date.now()): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(KEY(key), JSON.stringify({ v: value, t: now } satisfies Stored));
  } catch {
    // 配额满了或隐私模式 —— 服务端那份还在，不必惊动用户
  }
}

export function clearLocalDraft(key: string): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(KEY(key));
}
