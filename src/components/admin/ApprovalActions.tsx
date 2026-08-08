"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { useToast } from "@/components/ui/Toast";
import {
  approveAndExecute,
  rejectApproval,
  requestApproval,
  withdrawApproval,
} from "@/lib/admin/approval-actions";

/**
 * 危险操作的发起与复核。
 *
 * 「批准」和「驳回」长得一样重，且**批准的按钮上写的是会发生什么**
 * （「批准并执行」而不是「同意」）—— 批准之后立刻执行，
 * 中间没有第二次确认的机会。
 */

export function ApprovalDecision({
  id,
  isRequester,
  expired,
  describe,
}: {
  id: string;
  isRequester: boolean;
  expired: boolean;
  describe: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState("");

  const run = (fn: () => Promise<{ ok: boolean; error?: string; note?: string }>) => {
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        toast.show({ message: result.error ?? "操作失败", kind: "error" });
        return;
      }
      toast.show({ message: result.note ?? "已处理", kind: "success" });
      setNote("");
      router.refresh();
    });
  };

  if (expired) {
    return (
      <p className="t-caption rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 text-[var(--ink-tertiary)]">
        已过期。当时的判断依据可能已经变了 —— 如果还需要，请重新发起。
      </p>
    );
  }

  if (isRequester) {
    return (
      <div className="space-y-2">
        <p className="t-caption rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 text-[var(--ink-tertiary)]">
          这是你发起的，要另一个人来批 —— 自己批自己的话，这套机制就退化成一个确认弹窗。
        </p>
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => withdrawApproval({ id }))}
          className="t-caption rounded-[var(--radius-pill)] bg-[var(--fill)] px-2.5 py-1 text-[var(--ink-secondary)] disabled:opacity-40"
        >
          撤回
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        placeholder="复核意见（必填）"
        className="t-subhead w-full resize-none rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 outline-none placeholder:text-[var(--ink-quaternary)]"
      />
      <div className="flex gap-2">
        <button
          type="button"
          disabled={pending || !note.trim()}
          onClick={() => run(() => approveAndExecute({ id, note }))}
          className="t-subhead flex-1 rounded-[var(--radius-control)] bg-[var(--fill)] px-4 py-2 font-medium text-[var(--ink)] disabled:opacity-40"
        >
          {/* 按钮上写会发生什么。批准之后立刻执行，没有第二次确认 */}
          批准并执行
        </button>
        <button
          type="button"
          disabled={pending || !note.trim()}
          onClick={() => run(() => rejectApproval({ id, note }))}
          className="t-subhead flex-1 rounded-[var(--radius-control)] bg-[var(--fill)] px-4 py-2 font-medium text-[var(--ink)] disabled:opacity-40"
        >
          驳回
        </button>
      </div>
      <p className="t-caption2 text-[var(--ink-tertiary)]">
        批准即执行：{describe}
      </p>
    </div>
  );
}

/** 发起一个危险配置的修改 */
export function DangerousSettingRequest({
  options,
}: {
  options: { key: string; label: string; value: string }[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [key, setKey] = useState(options[0]?.key ?? "");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");

  const current = options.find((o) => o.key === key);

  if (options.length === 0) return null;

  return (
    <div className="space-y-2.5 rounded-[var(--radius-card)] bg-[var(--surface)] p-4 hairline">
      <p className="t-caption2 font-medium uppercase tracking-[0.06em] text-[var(--ink-quaternary)]">
        发起危险配置修改
      </p>

      <select value={key} onChange={(e) => setKey(e.target.value)} className={inputClass}>
        {options.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}（当前 {o.value}）
          </option>
        ))}
      </select>

      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={current ? `新值（当前 ${current.value}）` : "新值"}
        className={`tabular ${inputClass}`}
      />

      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
        placeholder="为什么要改（必填，复核的人要靠它判断）"
        className={`${inputClass} resize-none`}
      />

      <button
        type="button"
        disabled={pending || !key || !value.trim() || reason.trim().length < 6}
        onClick={() =>
          startTransition(async () => {
            const result = await requestApproval({
              action: "settings.update.dangerous",
              payload: { key, value: value.trim() },
              reason,
            });
            if (!result.ok) {
              toast.show({ message: result.error ?? "提交失败", kind: "error" });
              return;
            }
            toast.show({ message: result.note ?? "已提交", kind: "success" });
            setValue("");
            setReason("");
            router.refresh();
          })
        }
        className="t-subhead w-full rounded-[var(--radius-control)] bg-[var(--accent)] px-4 py-2 font-medium text-[var(--accent-ink)] disabled:opacity-40"
      >
        提交复核
      </button>
    </div>
  );
}

const inputClass =
  "t-subhead w-full rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 outline-none placeholder:text-[var(--ink-quaternary)]";
