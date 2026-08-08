"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

/**
 * 键盘快捷键。
 *
 * 桌面端的常客用键盘比用鼠标快得多，但有三条必须遵守，
 * 否则快捷键就从提效变成添乱：
 *
 *   1. **输入框里一律不拦截**。在写帖子时按 J 应该打出字母 J，
 *      而不是跳到下一条 —— 这是最常见也最惹人烦的实现失误
 *   2. **⌘/Ctrl 组合键不抢系统的**。⌘K 例外（业界已成惯例）
 *   3. **有地方能查**。按 ? 弹出速查表，不要让人去翻文档
 */

interface Shortcut {
  keys: string[];
  label: string;
  run: (router: ReturnType<typeof useRouter>) => void;
  /** 需要 ⌘/Ctrl */
  meta?: boolean;
}

const SHORTCUTS: Shortcut[] = [
  { keys: ["k"], meta: true, label: "搜索", run: (r) => r.push("/forum/search") },
  { keys: ["g", "h"], label: "回首页", run: (r) => r.push("/") },
  { keys: ["g", "f"], label: "去论坛", run: (r) => r.push("/forum") },
  { keys: ["g", "l"], label: "去排行", run: (r) => r.push("/leaderboard") },
  { keys: ["g", "n"], label: "去通知", run: (r) => r.push("/notifications") },
  { keys: ["g", "m"], label: "去我的", run: (r) => r.push("/me") },
  { keys: ["c"], label: "写新帖", run: (r) => r.push("/forum/new") },
];

/** 焦点在可输入元素里时不拦截任何按键 */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable ||
    // 打开的对话框里也不该触发全局跳转
    Boolean(target.closest("[role='dialog']"))
  );
}

export function Shortcuts() {
  const router = useRouter();
  const [help, setHelp] = useState(false);
  const [pending, setPending] = useState<string | null>(null);

  const handler = useCallback(
    (event: KeyboardEvent) => {
      if (isTyping(event.target)) return;

      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();

      if (mod && key === "k") {
        event.preventDefault();
        router.push("/forum/search");
        return;
      }
      if (mod || event.altKey) return;

      if (key === "?" || (event.shiftKey && key === "/")) {
        event.preventDefault();
        setHelp((open) => !open);
        return;
      }
      if (key === "escape") {
        setHelp(false);
        setPending(null);
        return;
      }

      // 双键序列：先按 g，再按目标键
      if (pending) {
        const match = SHORTCUTS.find(
          (s) => s.keys.length === 2 && s.keys[0] === pending && s.keys[1] === key,
        );
        setPending(null);
        if (match) {
          event.preventDefault();
          match.run(router);
        }
        return;
      }

      if (key === "g") {
        setPending("g");
        // 一秒内不接着按就作废，避免下次按键被误认成序列的第二下
        setTimeout(() => setPending(null), 1000);
        return;
      }

      const single = SHORTCUTS.find((s) => s.keys.length === 1 && !s.meta && s.keys[0] === key);
      if (single) {
        event.preventDefault();
        single.run(router);
      }
    },
    [pending, router],
  );

  useEffect(() => {
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handler]);

  if (!help) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="键盘快捷键"
      onClick={() => setHelp(false)}
      className="animate-fade fixed inset-0 z-50 hidden items-center justify-center bg-black/30 p-6 backdrop-blur-sm lg:flex"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="animate-rise w-full max-w-sm rounded-[var(--radius-sheet)] bg-[var(--surface)] p-5 shadow-[var(--shadow-raised)]"
      >
        <p className="t-headline mb-4">键盘快捷键</p>
        <ul className="space-y-2.5">
          {SHORTCUTS.map((shortcut) => (
            <li key={shortcut.label} className="flex items-center justify-between gap-4">
              <span className="t-subhead text-[var(--ink-secondary)]">{shortcut.label}</span>
              <span className="flex gap-1">
                {shortcut.meta && <Key>⌘</Key>}
                {shortcut.keys.map((key) => (
                  <Key key={key}>{key.toUpperCase()}</Key>
                ))}
              </span>
            </li>
          ))}
          <li className="flex items-center justify-between gap-4 border-t border-[var(--separator)] pt-2.5">
            <span className="t-subhead text-[var(--ink-secondary)]">这张表</span>
            <Key>?</Key>
          </li>
        </ul>
      </div>
    </div>
  );
}

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="tabular flex h-6 min-w-6 items-center justify-center rounded-[0.375rem] bg-[var(--fill)] px-1.5 font-mono text-[0.75rem] font-medium">
      {children}
    </kbd>
  );
}
