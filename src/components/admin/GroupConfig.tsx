"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { AdminActions, AdminButton, AdminChip, adminFieldClass } from "@/components/admin/ui";
import { useToast } from "@/components/ui/Toast";
import { updateGroupConfig } from "@/lib/admin/group-actions";
import type { GroupRow } from "@/lib/admin/groups";

/**
 * 单个群的配置。
 *
 * 最要紧的一条交互：**改高质量阈值时当场说清楚它不追溯**。
 *
 * 把阈值从 15 改成 20，历史消息的 is_quality 还是按 15 算的 ——
 * 榜单上的数字会长期与当前规则对不上，而这种不一致极难被发现：
 * 没有任何地方会报错，只是数字「有点怪」。
 * 所以提示在改动的那一刻就出现，而不是等保存后给一句 toast。
 */
export function GroupConfig({ group }: { group: GroupRow }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);

  const [qualityMin, setQualityMin] = useState<string>(
    group.qualityMin === null ? "" : String(group.qualityMin),
  );
  const [countForPoints, setCountForPoints] = useState(group.countForPoints);
  const [publicLeaderboard, setPublicLeaderboard] = useState(group.publicLeaderboard);
  const [retentionDays, setRetentionDays] = useState<string>(
    group.retentionDays === null ? "" : String(group.retentionDays),
  );
  const [syncExcluded, setSyncExcluded] = useState(group.syncExcluded);
  const [reason, setReason] = useState("");

  const parsedQuality = qualityMin.trim() === "" ? null : Number(qualityMin);
  const qualityChanged = parsedQuality !== group.qualityMin;

  const save = () => {
    startTransition(async () => {
      const result = await updateGroupConfig({
        convId: group.convId,
        qualityMin: parsedQuality,
        countForPoints,
        publicLeaderboard,
        retentionDays: retentionDays.trim() === "" ? null : Number(retentionDays),
        syncExcluded,
        reason,
      });

      if (!result.ok) {
        toast.show({ message: result.error ?? "保存失败", kind: "error" });
        return;
      }
      toast.show({ message: result.followUp ?? "已保存", kind: "success" });
      setOpen(false);
      setReason("");
      router.refresh();
    });
  };

  if (!open) {
    return (
      <AdminChip aria-expanded={false} onClick={() => setOpen(true)}>
        配置
      </AdminChip>
    );
  }

  return (
    <div className="animate-rise mt-3 space-y-3 rounded-[var(--radius-card)] bg-[var(--canvas)] p-3.5">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="t-caption2 mb-1 block text-[var(--ink-quaternary)]">
            高质量阈值（留空用全局 {group.effectiveQualityMin}）
          </span>
          <input
            type="number"
            min={1}
            value={qualityMin}
            onChange={(e) => setQualityMin(e.target.value)}
            placeholder={String(group.effectiveQualityMin)}
            className={`tabular ${adminFieldClass}`}
          />
        </label>

        <label className="block">
          <span className="t-caption2 mb-1 block text-[var(--ink-quaternary)]">
            消息保留天数（留空用全局）
          </span>
          <input
            type="number"
            min={1}
            value={retentionDays}
            onChange={(e) => setRetentionDays(e.target.value)}
            placeholder="不限"
            className={`tabular ${adminFieldClass}`}
          />
        </label>
      </div>

      {/* 提示在改动的那一刻就出现，不是等保存后给一句 toast */}
      {qualityChanged && (
        <p
          className="t-caption rounded-[var(--radius-control)] px-3 py-2 leading-relaxed"
          style={{
            background: "color-mix(in srgb, var(--warning) 10%, transparent)",
            color: "var(--warning)",
          }}
        >
          改了阈值<strong>不会追溯历史消息</strong>。已经入库的消息还是按旧阈值判定的，
          榜单会与新规则对不上 —— 要一致的话，保存后在服务器上跑{" "}
          <code className="font-mono">npm run resync -- {group.name}</code>。
        </p>
      )}

      <div className="space-y-1.5">
        <Toggle
          checked={countForPoints}
          onChange={setCountForPoints}
          label="计入积分与榜单"
          hint="关掉之后这个群的发言不再产生积分，也不进贡献榜"
        />
        <Toggle
          checked={publicLeaderboard}
          onChange={setPublicLeaderboard}
          label="允许在公开榜单里体现"
          hint="总榜对访客公开，但群的身份不外泄 —— 只用它做聚合，不显示群名"
        />
        <Toggle
          checked={syncExcluded}
          onChange={setSyncExcluded}
          label="排除同步"
          hint={
            group.bound
              ? "上游已绑定这个群。勾上之后本站不再收它的消息 —— 这是唯一能压过上游的开关"
              : "上游没有绑定这个群，本来就不会同步"
          }
        />
      </div>

      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="理由（必填，会记入审计日志）"
        className={adminFieldClass}
      />

      <AdminActions>
        <AdminButton
          tone="primary"
          className="flex-1"
          disabled={pending || !reason.trim()}
          title={reason.trim() ? undefined : "先写一句理由"}
          onClick={save}
        >
          保存
        </AdminButton>
        <AdminButton tone="quiet" onClick={() => setOpen(false)}>
          取消
        </AdminButton>
      </AdminActions>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <label className="flex items-start gap-2.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4 shrink-0"
      />
      <span className="min-w-0">
        <span className="t-subhead block">{label}</span>
        <span className="t-caption block text-[var(--ink-tertiary)]">{hint}</span>
      </span>
    </label>
  );
}
