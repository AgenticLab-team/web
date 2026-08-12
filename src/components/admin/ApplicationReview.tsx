"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { AdminButton } from "@/components/admin/ui";
import { useToast } from "@/components/ui/Toast";
import { fulfillApplication, reviewApplication } from "@/lib/activities/actions";
import type { ApplicationRow } from "@/lib/activities/queries";

/**
 * 申请审批与履约回填。
 *
 * 审批时把**申请那一刻的资格快照**摆出来 ——
 * 事后有人质疑「凭什么他能申请我不能」，翻快照即可，无从争议。
 * 只显示当前数据的话，两周后数据变了就说不清了。
 */
export function ApplicationReview({ app }: { app: ApplicationRow }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState("");
  const [showSnapshot, setShowSnapshot] = useState(false);

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        toast.show({ message: result.error ?? "操作失败", kind: "error" });
        return;
      }
      toast.show({ message: "已处理并通知申请人", kind: "success" });
      setNote("");
      router.refresh();
    });
  };

  const pendingReview = app.status === "submitted" || app.status === "waitlisted";
  const pendingFulfill = app.status === "approved" || app.status === "fulfilling";

  if (!pendingReview && !pendingFulfill) return null;

  return (
    <div className="mt-2 space-y-2">
      {app.eligibilitySnapshot && (
        <>
          <AdminButton
            tone="quiet"
            size="sm"
            aria-expanded={showSnapshot}
            onClick={() => setShowSnapshot(!showSnapshot)}
            className="-ml-2.5 text-[var(--accent)]"
          >
            {showSnapshot ? "收起" : "查看申请时的资格快照"}
          </AdminButton>
          {showSnapshot && (
            <div className="rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2">
              <p className="t-caption2 mb-1 text-[var(--ink-quaternary)]">
                申请那一刻的数据 —— 事后有争议时以此为准
              </p>
              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 sm:grid-cols-3">
                {Object.entries(app.eligibilitySnapshot)
                  .filter(([, v]) => typeof v === "number" || typeof v === "string")
                  .filter(([k]) => k !== "userId" && k !== "name")
                  .map(([k, v]) => (
                    <p key={k} className="t-caption2 text-[var(--ink-tertiary)]">
                      {k} <span className="tabular text-[var(--ink-secondary)]">{String(v)}</span>
                    </p>
                  ))}
              </div>
            </div>
          )}
        </>
      )}

      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={pendingFulfill ? "注册结果（申请人会看到）" : "审批意见（申请人会看到）"}
        className="t-subhead w-full rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 outline-none placeholder:text-[var(--ink-quaternary)]"
      />

      <div className="flex gap-2">
        {pendingReview && (
          <>
            <ActionButton
              disabled={pending || !note.trim()}
              onClick={() => run(() => reviewApplication({ id: app.id, to: "approved", note }))}
            >
              通过
            </ActionButton>
            <ActionButton
              disabled={pending || !note.trim()}
              onClick={() => run(() => reviewApplication({ id: app.id, to: "rejected", note }))}
            >
              驳回
            </ActionButton>
          </>
        )}

        {pendingFulfill && (
          <>
            <ActionButton
              disabled={pending || !note.trim()}
              onClick={() => run(() => fulfillApplication({ id: app.id, success: true, note }))}
            >
              注册成功
            </ActionButton>
            <ActionButton
              disabled={pending || !note.trim()}
              onClick={() => run(() => fulfillApplication({ id: app.id, success: false, note }))}
            >
              {/* 失败会把名额还回来，让候补的人补上 */}
              注册失败
            </ActionButton>
          </>
        )}
      </div>
    </div>
  );
}

function ActionButton({
  children,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  disabled: boolean;
  onClick: () => void;
}) {
  // 通过与驳回同样重 —— 把通过做成主色等于在界面上鼓励点它
  return (
    <AdminButton tone="neutral" className="flex-1" disabled={disabled} onClick={onClick}>
      {children}
    </AdminButton>
  );
}
