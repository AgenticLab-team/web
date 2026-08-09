"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { useToast } from "@/components/ui/Toast";
import { refund, updateOrderStatus } from "@/lib/shop/actions";
import type { OrderStatus } from "@/lib/shop/types";

/**
 * 订单处理。
 *
 * 每一步都要写说明，而且说明会**原样发给用户** ——
 * 「已发货」三个字加一个运单号，比一个静默的状态变化有用得多：
 * 用户花掉的分是真的没了，他有权知道东西到哪了。
 */
export function OrderActions({ id, status }: { id: string; status: OrderStatus }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState("");
  const [tracking, setTracking] = useState("");
  const [open, setOpen] = useState(false);

  const next: { to: OrderStatus; label: string }[] =
    status === "pending"
      ? [
          { to: "shipping", label: "标记已发货" },
          { to: "fulfilled", label: "标记已交付" },
        ]
      : status === "shipping"
        ? [{ to: "delivered", label: "标记已签收" }]
        : [];

  const canRefund = !["delivered", "cancelled", "refunded"].includes(status);
  if (next.length === 0 && !canRefund) return null;

  const run = (fn: () => Promise<{ ok: boolean; error?: string; note?: string }>) => {
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        toast.show({ message: result.error ?? "操作失败", kind: "error" });
        return;
      }
      toast.show({ message: result.note ?? "已处理并通知用户", kind: "success" });
      setNote("");
      setTracking("");
      setOpen(false);
      router.refresh();
    });
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="t-caption mt-2 rounded-[var(--radius-pill)] bg-[var(--fill)] px-2.5 py-1 text-[var(--ink-secondary)]"
      >
        处理
      </button>
    );
  }

  return (
    <div className="animate-rise mt-2 space-y-2">
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="处理说明（会原样发给用户）"
        className={inputClass}
      />

      {status === "pending" && (
        <input
          value={tracking}
          onChange={(e) => setTracking(e.target.value)}
          placeholder="运单号（发货时填）"
          className={`font-mono ${inputClass}`}
        />
      )}

      <div className="flex flex-wrap gap-2">
        {next.map((n) => (
          <button
            key={n.to}
            type="button"
            disabled={pending || !note.trim()}
            onClick={() =>
              run(() =>
                updateOrderStatus({ id, status: n.to, note, trackingNo: tracking || undefined }),
              )
            }
            className="t-subhead flex-1 rounded-[var(--radius-control)] bg-[var(--fill)] px-4 py-2 font-medium disabled:opacity-40"
          >
            {n.label}
          </button>
        ))}

        {canRefund && (
          <button
            type="button"
            disabled={pending || !note.trim()}
            onClick={() => run(() => refund({ id, reason: note }))}
            className="t-subhead rounded-[var(--radius-control)] px-4 py-2 font-medium disabled:opacity-40"
            style={{ background: "color-mix(in srgb, var(--danger) 12%, transparent)", color: "var(--danger)" }}
          >
            退款
          </button>
        )}
      </div>
    </div>
  );
}

const inputClass =
  "t-subhead w-full rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 outline-none placeholder:text-[var(--ink-quaternary)]";
