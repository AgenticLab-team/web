"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  AdminBlocked,
  AdminButton,
  AdminChip,
  AdminNote,
  AdminPanel,
  adminFieldClass,
} from "@/components/admin/ui";
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

  if (props.conflict) return <AdminBlocked>{props.conflict}</AdminBlocked>;

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
          <AdminChip
            disabled={pending}
            onClick={() =>
              run(
                () => claimReports({ targetType: props.targetType, targetId: props.targetId }),
                "已认领，其他人会看到你在处理",
              )
            }
          >
            我来处理
          </AdminChip>
        )}
        <AdminChip active={open} aria-expanded={open} onClick={() => setOpen(!open)}>
          结案
        </AdminChip>
      </div>

      {open && (
        <AdminPanel className="animate-rise space-y-2.5">
          <div className="flex flex-wrap gap-1.5">
            {OUTCOMES.map((o) => (
              <AdminChip
                key={o.key}
                active={outcome === o.key}
                onClick={() => setOutcome(o.key)}
                title={o.hint}
              >
                {o.label}
              </AdminChip>
            ))}
          </div>

          {/* 选中那一档的代价写在框下面而不是只挂 title —— 触屏上没有悬停，
              title 里那句话在手机上等于不存在 */}
          <p className="t-caption2 text-[var(--ink-quaternary)]">
            {OUTCOMES.find((o) => o.key === outcome)?.hint}
          </p>

          <textarea
            value={resolution}
            onChange={(e) => setResolution(e.target.value)}
            rows={2}
            placeholder="怎么处理的（会原样发给每一位举报人）"
            className={`resize-none ${adminFieldClass}`}
          />

          <AdminButton
            tone="primary"
            block
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
          >
            确认结案
          </AdminButton>

          <AdminNote className="px-0">
            这只是对举报的结论。删帖、禁言请在对应内容或用户页面单独执行，各自留处罚记录。
          </AdminNote>
        </AdminPanel>
      )}
    </div>
  );
}
