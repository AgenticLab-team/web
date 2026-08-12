"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { AdminButton } from "@/components/admin/ui";
import { useToast } from "@/components/ui/Toast";
import { retryAllFailed, retrySyncJob, triggerSync } from "@/lib/admin/group-actions";

/**
 * 同步的手动控制。
 *
 * 所有按钮都只是**排队**，不在 web 请求里直接跑同步 ——
 * 请求超时会把跑到一半的任务丢下，而游标已经动过了，
 * 那一段消息就永远补不回来。所以提示语说的是「已排队」而不是「已同步」，
 * 那不是措辞讲究，是如实描述发生了什么。
 */
export function SyncControls({
  kind,
  label,
  retryableId,
}: {
  kind?: string;
  label?: string;
  retryableId?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  const run = (fn: () => Promise<{ ok: boolean; error?: string; followUp?: string }>) => {
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        toast.show({ message: result.error ?? "操作失败", kind: "error" });
        return;
      }
      toast.show({ message: result.followUp ?? "已排队", kind: "success" });
      router.refresh();
    });
  };

  /*
   * 三个入口都用 neutral —— 它们只是**排队**，不真的动数据，
   * 所以一点危险色都不该有。sm 那两个在列表行里，
   * 靠 tap-target 把可点范围撑回 44px。
   */
  if (retryableId) {
    return (
      <AdminButton
        tone="neutral"
        size="sm"
        disabled={pending}
        onClick={() => run(() => retrySyncJob({ id: retryableId }))}
      >
        重试
      </AdminButton>
    );
  }

  if (kind) {
    return (
      <AdminButton
        tone="neutral"
        size="sm"
        disabled={pending}
        onClick={() => run(() => triggerSync({ kind }))}
      >
        立即同步{label ? ` ${label}` : ""}
      </AdminButton>
    );
  }

  return (
    <AdminButton tone="neutral" size="sm" disabled={pending} onClick={() => run(retryAllFailed)}>
      重试全部失败
    </AdminButton>
  );
}
