"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";

import { THEME_STORAGE_KEY, readThemeChoice, type ThemeChoice } from "@/lib/theme";

const OPTIONS: { value: ThemeChoice; label: string; Icon: typeof Sun }[] = [
  { value: "system", label: "自动", Icon: Monitor },
  { value: "light", label: "浅色", Icon: Sun },
  { value: "dark", label: "深色", Icon: Moon },
];

/**
 * 配色偏好存在 localStorage 里，那是 React 之外的状态。
 *
 * 原先用 useEffect + setState 在挂载后读一次，有两个毛病：
 * 一次多余的级联渲染，以及**多标签页不同步** ——
 * 在一个标签里切成深色，另一个标签还是浅色，直到刷新。
 *
 * useSyncExternalStore 就是为这种情况准备的：
 * 服务端快照固定是「自动」，客户端读真实值，写入时通知所有订阅者。
 */
const listeners = new Set<() => void>();

function subscribe(callback: () => void) {
  listeners.add(callback);
  // storage 事件只在**别的**标签页写入时触发，正好用来做跨标签同步
  window.addEventListener("storage", callback);
  return () => {
    listeners.delete(callback);
    window.removeEventListener("storage", callback);
  };
}

function getSnapshot(): ThemeChoice {
  return readThemeChoice(localStorage.getItem(THEME_STORAGE_KEY));
}

/** 服务端渲染时没有 localStorage，一律按「自动」渲染 */
function getServerSnapshot(): ThemeChoice {
  return "system";
}

function applyTheme(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === "system") {
    root.removeAttribute("data-theme");
    localStorage.removeItem(THEME_STORAGE_KEY);
  } else {
    root.setAttribute("data-theme", choice);
    localStorage.setItem(THEME_STORAGE_KEY, choice);
  }
  // 同一个标签页内 storage 事件不会触发，得自己通知
  for (const listener of listeners) listener();
}

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const active = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const select = (next: ThemeChoice) => applyTheme(next);

  return (
    <div
      role="radiogroup"
      aria-label="配色方案"
      className={`flex gap-0.5 rounded-[var(--radius-control)] bg-[var(--fill)] p-0.5 ${
        compact ? "" : "w-full"
      }`}
    >
      {OPTIONS.map((option) => {
        const isActive = active === option.value;
        return (
          <button
            key={option.value}
            role="radio"
            aria-checked={isActive}
            aria-label={option.label}
            onClick={() => select(option.value)}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-[0.4375rem] py-1.5 transition ${
              isActive
                ? "bg-[var(--surface)] text-[var(--ink)] shadow-[0_1px_2px_rgb(0_0_0/0.06)]"
                : "text-[var(--ink-tertiary)] hover:text-[var(--ink-secondary)]"
            }`}
          >
            <option.Icon className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            {!compact && <span className="t-caption font-medium">{option.label}</span>}
          </button>
        );
      })}
    </div>
  );
}
