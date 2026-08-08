"use client";

import { AlertCircle, Check, Undo2, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * Toast 与撤销。
 *
 * 这是 HIG 里我最认同的一条：**可撤销优于二次确认**。
 *
 * 「确定要删除吗？」这种弹窗打断心流，而且会让人养成无脑点确定的习惯 ——
 * 真正危险的操作反而被忽略。删除直接执行，底部浮出「已删除 · 撤销」，
 * 几秒内可恢复。只有**不可逆**的操作（删号、清空数据）才用确认。
 */

export interface ToastAction {
  label: string;
  run: () => void | Promise<void>;
}

export interface ToastOptions {
  message: string;
  kind?: "info" | "success" | "error";
  /** 撤销入口。给了这个就不该再弹确认框 */
  undo?: () => void | Promise<void>;
  durationMs?: number;
}

interface ToastItem extends ToastOptions {
  id: number;
  createdAt: number;
  duration: number;
}

interface ToastContextValue {
  show: (options: ToastOptions) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  // 没有 Provider 时退化成静默，而不是让整个页面崩掉
  return context ?? { show: () => {} };
}

let nextId = 1;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const show = useCallback(
    (options: ToastOptions) => {
      const id = nextId++;
      // 有撤销入口时给足时间，否则来不及反应就消失了
      const duration = options.durationMs ?? (options.undo ? 6000 : 3200);
      setItems((current) => [...current.slice(-2), { ...options, id, createdAt: Date.now(), duration }]);
      timers.current.set(id, setTimeout(() => dismiss(id), duration));
    },
    [dismiss],
  );

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const timer of map.values()) clearTimeout(timer);
      map.clear();
    };
  }, []);

  const value = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 z-50 flex flex-col items-center gap-2 px-4"
        style={{
          bottom: "calc(var(--tabbar-height) + env(safe-area-inset-bottom, 0px) + 1rem)",
        }}
        // 屏幕阅读器要能读到操作结果，否则视障用户完全不知道发生了什么
        role="status"
        aria-live="polite"
      >
        {items.map((item) => (
          <ToastCard key={item.id} item={item} onDismiss={() => dismiss(item.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const [running, setRunning] = useState(false);

  const Icon = item.kind === "error" ? AlertCircle : item.kind === "success" ? Check : null;

  return (
    <div className="animate-rise pointer-events-auto relative flex w-full max-w-sm items-center gap-3 overflow-hidden rounded-[var(--radius-control)] bg-[var(--ink)] px-4 py-3 text-[var(--canvas)] shadow-[var(--shadow-raised)]">
      {Icon && (
        <Icon
          className={`h-4 w-4 shrink-0 ${item.kind === "error" ? "text-[var(--danger)]" : ""}`}
          strokeWidth={2.2}
          aria-hidden
        />
      )}

      <span className="t-subhead min-w-0 flex-1">{item.message}</span>

      {item.undo && (
        <button
          type="button"
          disabled={running}
          onClick={async () => {
            setRunning(true);
            await item.undo?.();
            onDismiss();
          }}
          className="t-subhead flex shrink-0 items-center gap-1 rounded-[var(--radius-pill)] bg-[var(--canvas)]/15 px-2.5 py-1 font-medium transition active:scale-95 disabled:opacity-50"
        >
          <Undo2 className="h-3.5 w-3.5" strokeWidth={2.2} aria-hidden />
          撤销
        </button>
      )}

      <button
        type="button"
        onClick={onDismiss}
        aria-label="关闭"
        className="shrink-0 rounded-full p-1 opacity-50 transition hover:opacity-100"
      >
        <X className="h-3.5 w-3.5" strokeWidth={2.2} aria-hidden />
      </button>

      {/* 剩余时间条。让人知道还有多久可以撤销，而不是凭感觉 */}
      <span
        className="absolute bottom-0 left-0 h-0.5 bg-[var(--canvas)]/40"
        style={{ animation: `toast-progress ${item.duration}ms linear forwards` }}
        aria-hidden
      />
    </div>
  );
}
