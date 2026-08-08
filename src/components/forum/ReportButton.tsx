"use client";

import { Flag } from "lucide-react";
import { useState, useTransition } from "react";

import { submitReport } from "@/lib/forum/moderation";

const REASONS = [
  { code: "spam", label: "广告或垃圾信息" },
  { code: "abuse", label: "辱骂或人身攻击" },
  { code: "porn", label: "色情低俗" },
  { code: "illegal", label: "违法违规" },
  { code: "privacy", label: "泄露他人隐私" },
  { code: "offtopic", label: "与版块无关" },
  { code: "other", label: "其它" },
] as const;

/**
 * 举报。
 *
 * 提交后只说「已收到」，不透露后续处理进度 ——
 * 告诉举报人「这条被删了」等于把处理结果反馈给了可能的恶意举报者，
 * 也会让被举报人猜出是谁举报的。
 */
export function ReportButton({
  targetType,
  targetId,
}: {
  targetType: "post" | "reply";
  targetId: string;
}) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const [detail, setDetail] = useState("");
  const [reason, setReason] = useState<(typeof REASONS)[number]["code"]>("spam");
  const [pending, startTransition] = useTransition();

  if (done) {
    return (
      <span className="t-caption text-[var(--ink-tertiary)]">已收到，我们会尽快处理</span>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="举报"
        title="举报"
        className="rounded-[0.5rem] p-2 text-[var(--ink-quaternary)] transition-colors hover:bg-[var(--fill)] hover:text-[var(--danger)]"
      >
        <Flag className="h-4 w-4" strokeWidth={1.9} aria-hidden />
      </button>
    );
  }

  return (
    <div className="w-full space-y-2 rounded-[var(--radius-card)] bg-[var(--fill)] p-3">
      <div className="flex flex-wrap gap-1.5">
        {REASONS.map((r) => (
          <button
            key={r.code}
            type="button"
            onClick={() => setReason(r.code)}
            className={`t-caption rounded-[var(--radius-pill)] px-2.5 py-1 transition-colors ${
              reason === r.code
                ? "bg-[var(--ink)] text-[var(--canvas)]"
                : "bg-[var(--surface)] text-[var(--ink-secondary)]"
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>

      <textarea
        value={detail}
        onChange={(e) => setDetail(e.target.value)}
        placeholder="补充说明（可选）"
        maxLength={500}
        rows={2}
        className="t-footnote w-full resize-none rounded-[var(--radius-control)] bg-[var(--surface)] px-3 py-2 outline-none placeholder:text-[var(--ink-quaternary)]"
      />

      <div className="flex gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              await submitReport({ targetType, targetId, reasonCode: reason, detail });
              setOpen(false);
              setDone(true);
            })
          }
          className="t-footnote flex-1 rounded-[var(--radius-control)] bg-[var(--danger)] px-4 py-2 font-medium text-white disabled:opacity-50"
        >
          提交举报
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="t-footnote rounded-[var(--radius-control)] bg-[var(--surface)] px-4 py-2"
        >
          取消
        </button>
      </div>
    </div>
  );
}
