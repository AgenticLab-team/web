"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { AdminActions, AdminButton, AdminChip, adminFieldClass } from "@/components/admin/ui";
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
      <AdminChip className="mt-2" aria-expanded={false} onClick={() => setOpen(true)}>
        处理这笔订单
      </AdminChip>
    );
  }

  return (
    <div className="animate-rise mt-2 space-y-2">
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="处理说明（会原样发给用户）"
        className={adminFieldClass}
      />

      {status === "pending" && (
        <input
          value={tracking}
          onChange={(e) => setTracking(e.target.value)}
          placeholder="运单号（发货时填）"
          className={`font-mono ${adminFieldClass}`}
        />
      )}

      <AdminActions>
        {next.map((n) => (
          <AdminButton
            key={n.to}
            tone="neutral"
            className="flex-1"
            disabled={pending || !note.trim()}
            title={note.trim() ? undefined : "先写一句说明 —— 它会原样发给用户"}
            onClick={() =>
              run(() =>
                updateOrderStatus({ id, status: n.to, note, trackingNo: tracking || undefined }),
              )
            }
          >
            {n.label}
          </AdminButton>
        ))}

        {/* 退款是可撤销的（会冲正回去），所以是 dangerSoft 不是实心红 */}
        {canRefund && (
          <AdminButton
            tone="dangerSoft"
            disabled={pending || !note.trim()}
            onClick={() => run(() => refund({ id, reason: note }))}
          >
            退款
          </AdminButton>
        )}

        <AdminButton tone="quiet" onClick={() => setOpen(false)}>
          收起
        </AdminButton>
      </AdminActions>
    </div>
  );
}
