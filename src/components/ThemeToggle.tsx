"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

import { THEME_STORAGE_KEY, type ThemeChoice } from "@/lib/theme";

const OPTIONS: { value: ThemeChoice; label: string; Icon: typeof Sun }[] = [
  { value: "system", label: "自动", Icon: Monitor },
  { value: "light", label: "浅色", Icon: Sun },
  { value: "dark", label: "深色", Icon: Moon },
];

function applyTheme(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === "system") {
    root.removeAttribute("data-theme");
    localStorage.removeItem(THEME_STORAGE_KEY);
  } else {
    root.setAttribute("data-theme", choice);
    localStorage.setItem(THEME_STORAGE_KEY, choice);
  }
}

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const [choice, setChoice] = useState<ThemeChoice>("system");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    setChoice(stored === "light" || stored === "dark" ? stored : "system");
    setMounted(true);
  }, []);

  const select = (next: ThemeChoice) => {
    setChoice(next);
    applyTheme(next);
  };

  // 未挂载前不渲染选中态，否则服务端渲染的默认值与本地存储不一致会造成闪动
  const active = mounted ? choice : null;

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
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-[0.4375rem] py-1.5 transition-all duration-200 ${
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
