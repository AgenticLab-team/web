"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { useToast } from "@/components/ui/Toast";
import { claimReports, resolveReports } from "@/lib/admin/report-actions";

/**
 * 举报处置。
 *
 * 三个设计取舍：
 *
 * 1. **处置结论和内容处置分开**。这里只回答「举报成不成立」，
 *    删帖禁言走各自的按钮 —— 「属实但这次只警告」是很常见的组合，
 *    合成一个动作就表达不出来了。
 * 2. **说明框先于按钮出现**，而不是点完再问。它会原样发给举报人，
 *    所以写的时候就该知道有人会读。
 * 3. 利益冲突（自己举报的、举报自己的）在**渲染时就禁用按钮**并说明原因，
 *    不是点下去才弹一句「不允许」。
 */

interface Props {
  targetType: string;
  targetId: string;
  assigned: boolean;
  /** 当前管理员是否与这批举报有利益冲突，有的话说明是哪一种 */
  conflict: string | null;
}

const OUTCOMES = [
  { key: "resolved", label: "举报属实", hint: "已按说明处置" },
  { key: "rejected", label: "举报不成立", hint: "内容没有问题" },
  { key: "duplicate", label: "重复举报", hint: "同一件事已在别处处理" },
] as const;

export function ReportActions(props: Props) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<(typeof OUTCOMES)[number]["key"]>("resolved");
  const [resolution, setResolution] = useState("");

  if (props.conflict) {
    return (
      <p className="t-caption rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 text-[var(--ink-tertiary)]">
        {props.conflict}
      </p>
    );
  }

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, success: string) => {
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) toast.show({ message: result.error ?? "操作失败", kind: "error" });
      else {
        toast.show({ message: success, kind: "success" });
        setOpen(false);
        setResolution("");
        router.refresh();
      }
    });
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {!props.assigned && (
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              run(
                () => claimReports({ targetType: props.targetType, targetId: props.targetId }),
                "已认领，其他人会看到你在处理",
              )
            }
            className="t-footnote rounded-[var(--radius-pill)] bg-[var(--fill)] px-3 py-1.5 font-medium text-[var(--ink-secondary)] disabled:opacity-40"
          >
            我来处理
          </button>
        )}
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className={`t-footnote rounded-[var(--radius-pill)] px-3 py-1.5 font-medium transition-colors ${
            open
              ? "bg-[var(--ink)] text-[var(--canvas)]"
              : "bg-[var(--fill)] text-[var(--ink-secondary)]"
          }`}
        >
          结案
        </button>
      </div>

      {open && (
        <div className="animate-rise space-y-2.5 rounded-[var(--radius-card)] bg-[var(--surface)] p-3 hairline">
          <div className="flex flex-wrap gap-1.5">
            {OUTCOMES.map((o) => (
              <button
                key={o.key}
                type="button"
                onClick={() => setOutcome(o.key)}
                title={o.hint}
                className={`t-footnote rounded-[var(--radius-pill)] px-3 py-1.5 transition-colors ${
                  outcome === o.key
                    ? "bg-[var(--accent)] font-medium text-[var(--accent-ink)]"
                    : "bg-[var(--fill)] text-[var(--ink-secondary)]"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>

          <textarea
            value={resolution}
            onChange={(e) => setResolution(e.target.value)}
            rows={2}
            placeholder="怎么处理的（会原样发给每一位举报人）"
            className="t-subhead w-full resize-none rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 outline-none placeholder:text-[var(--ink-quaternary)]"
          />

          <button
            type="button"
            disabled={pending || !resolution.trim()}
            onClick={() =>
              run(
                () =>
                  resolveReports({
                    targetType: props.targetType,
                    targetId: props.targetId,
                    outcome,
                    resolution,
                  }),
                "已结案并通知举报人",
              )
            }
            className="t-subhead w-full rounded-[var(--radius-control)] bg-[var(--accent)] px-4 py-2 font-medium text-[var(--accent-ink)] disabled:opacity-40"
          >
            确认结案
          </button>

          <p className="t-caption text-[var(--ink-tertiary)]">
            这只是对举报的结论。删帖、禁言请在对应内容或用户页面单独执行，各自留处罚记录。
          </p>
        </div>
      )}
    </div>
  );
}
