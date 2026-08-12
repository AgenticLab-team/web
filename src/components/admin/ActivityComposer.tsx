"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { AdminButton, adminFieldClass } from "@/components/admin/ui";
import { EligibilityEditor } from "@/components/admin/EligibilityEditor";
import { useToast } from "@/components/ui/Toast";
import { saveActivity, setActivityStatus } from "@/lib/activities/actions";
import type { Rule } from "@/lib/activities/eligibility";

/**
 * 新建活动。
 *
 * **名额和资格规则在开放之后不能改** —— 改了的话，
 * 先报名的人按一套标准、后报名的按另一套，
 * 而先报名的往往正是最积极的那批人。所以这里默认建成草稿，
 * 开放是一个单独的、明确的动作。
 */
export function ActivityComposer({
  modules,
}: {
  modules: { key: string; label: string; description: string }[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);

  const [moduleKey, setModuleKey] = useState(modules[0]?.key ?? "");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [quota, setQuota] = useState("60");
  const [perUserLimit, setPerUserLimit] = useState("1");
  const [allowWaitlist, setAllowWaitlist] = useState(true);
  const [hours, setHours] = useState("12");
  const [eligibility, setEligibility] = useState<Rule | null>(null);
  // 这轮放的是 .icu —— .sh 一个几百块，60 个发不起
  const [tlds, setTlds] = useState("icu");

  if (!open) {
    return (
      <AdminButton tone="primary" block aria-expanded={false} onClick={() => setOpen(true)}>
        新建活动
      </AdminButton>
    );
  }

  const submit = () => {
    startTransition(async () => {
      const now = Date.now();
      const result = await saveActivity({
        moduleKey,
        title,
        description,
        quotaTotal: quota.trim() === "" ? null : Number(quota),
        perUserLimit: Number(perUserLimit) || 1,
        allowWaitlist,
        opensAt: now,
        closesAt: hours.trim() === "" ? null : now + Number(hours) * 3600_000,
        eligibility,
        config: moduleKey === "domain" ? { tlds: tlds.split(/[,\s]+/).filter(Boolean) } : {},
      });

      if (!result.ok) {
        toast.show({ message: result.error ?? "创建失败", kind: "error" });
        return;
      }
      toast.show({ message: "已创建为草稿 —— 确认无误后再开放", kind: "success" });
      setOpen(false);
      setTitle("");
      router.refresh();
    });
  };

  return (
    <div className="animate-rise space-y-3 rounded-[var(--radius-card)] bg-[var(--surface)] p-4 hairline">
      <select value={moduleKey} onChange={(e) => setModuleKey(e.target.value)} className={adminFieldClass}>
        {modules.map((m) => (
          <option key={m.key} value={m.key}>
            {m.label} —— {m.description}
          </option>
        ))}
      </select>

      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="活动标题"
        className={adminFieldClass}
      />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={2}
        placeholder="说明（用户会看到）"
        className={`${adminFieldClass} resize-none`}
      />

      <div className="grid gap-2 sm:grid-cols-3">
        <label className="block">
          <span className="t-caption2 mb-1 block text-[var(--ink-quaternary)]">名额（留空不限）</span>
          <input
            type="number"
            value={quota}
            onChange={(e) => setQuota(e.target.value)}
            className={`tabular ${adminFieldClass}`}
          />
        </label>
        <label className="block">
          <span className="t-caption2 mb-1 block text-[var(--ink-quaternary)]">每人上限</span>
          <input
            type="number"
            value={perUserLimit}
            onChange={(e) => setPerUserLimit(e.target.value)}
            className={`tabular ${adminFieldClass}`}
          />
        </label>
        <label className="block">
          <span className="t-caption2 mb-1 block text-[var(--ink-quaternary)]">开放小时数</span>
          <input
            type="number"
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            className={`tabular ${adminFieldClass}`}
          />
        </label>
      </div>

      {moduleKey === "domain" && (
        <label className="block">
          <span className="t-caption2 mb-1 block text-[var(--ink-quaternary)]">
            允许的后缀（逗号分隔）
          </span>
          <input value={tlds} onChange={(e) => setTlds(e.target.value)} className={adminFieldClass} />
        </label>
      )}

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={allowWaitlist}
          onChange={(e) => setAllowWaitlist(e.target.checked)}
          className="h-4 w-4"
        />
        <span className="t-subhead">名额满了之后允许候补</span>
      </label>

      <EligibilityEditor value={eligibility} onChange={setEligibility} />

      <AdminButton tone="primary" block disabled={pending || !title.trim()} onClick={submit}>
        创建为草稿
      </AdminButton>

      <p className="t-caption leading-relaxed text-[var(--ink-tertiary)]">
        创建后是草稿，开放是单独的一步 ——
        <strong>名额和资格规则一旦开放就不能再改</strong>：
        改了的话先报名的人和后报名的人按不同标准，而先报名的往往正是最积极的那批。
      </p>
    </div>
  );
}

/** 活动的状态操作 */
export function ActivityStatusActions({
  id,
  status,
}: {
  id: string;
  status: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [reason, setReason] = useState("");

  const next: { to: string; label: string }[] =
    status === "draft"
      ? [{ to: "open", label: "开放" }]
      : status === "open"
        ? [{ to: "closed", label: "截止" }]
        : status === "closed"
          ? [{ to: "reviewing", label: "开始审核" }]
          : status === "reviewing"
            ? [{ to: "fulfilling", label: "开始履约" }]
            : status === "fulfilling"
              ? [{ to: "completed", label: "标记完成" }]
              : [];

  const run = (to: string) => {
    startTransition(async () => {
      const result = await setActivityStatus({ id, status: to as "open", reason });
      if (!result.ok) {
        toast.show({ message: result.error ?? "操作失败", kind: "error" });
        return;
      }
      toast.show({ message: "已更新", kind: "success" });
      setReason("");
      router.refresh();
    });
  };

  const canCancel = !["completed", "cancelled"].includes(status);
  if (next.length === 0 && !canCancel) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {next.map((n) => (
        <AdminButton key={n.to} tone="neutral" size="sm" disabled={pending} onClick={() => run(n.to)}>
          {n.label}
        </AdminButton>
      ))}

      {canCancel && (
        <>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="取消原因"
            aria-label="取消这个活动的原因"
            className={`flex-1 ${adminFieldClass}`}
          />
          {/* 取消活动会把名额全退回去，报名的人都收到通知 —— 撤不回来，实心红 */}
          <AdminButton
            tone="danger"
            size="sm"
            disabled={pending || !reason.trim()}
            title={reason.trim() ? undefined : "先写一句取消原因"}
            onClick={() => run("cancelled")}
          >
            取消活动
          </AdminButton>
        </>
      )}
    </div>
  );
}
