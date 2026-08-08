"use client";

import { Flame, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { useToast } from "@/components/ui/Toast";
import { checkinAction } from "@/lib/points/actions";

/**
 * 打卡卡片。
 *
 * 三种状态各有各的话要说：
 *   还差几条 —— 说清楚差多少，而不是把按钮灰掉了事
 *   可以打卡 —— 主操作，最显眼
 *   已打卡   —— 展示连胜，给继续的理由
 *
 * 按钮灰掉不说原因是最劝退的做法：用户不知道要做什么才能亮起来。
 */
export function CheckinCard({
  canCheckin,
  checkedToday,
  message,
  need,
  have,
  streak,
  streakBest,
}: {
  canCheckin: boolean;
  checkedToday: boolean;
  message: string;
  need: number;
  have: number;
  streak: number;
  streakBest: number;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [celebrating, setCelebrating] = useState(false);

  const run = () => {
    startTransition(async () => {
      const result = await checkinAction();
      if (!result.ok) {
        toast.show({ message: result.error ?? "打卡失败", kind: "error" });
        return;
      }
      setCelebrating(true);
      setTimeout(() => setCelebrating(false), 1600);
      toast.show({
        message: result.leveledUp
          ? `+${result.awarded} 分 · 升到 L${result.leveledUp.to} 了`
          : `+${result.awarded} 分 · 连胜 ${result.streak} 天`,
        kind: "success",
      });
      router.refresh();
    });
  };

  if (checkedToday) {
    return (
      <div className="inset-group flex items-center gap-3.5 p-4">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)]">
          <Flame className="h-5 w-5 text-[var(--accent)]" strokeWidth={2} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="t-body leading-tight">今天已打卡</p>
          <p className="tabular t-caption mt-0.5 text-[var(--ink-tertiary)]">
            连胜 {streak} 天{streakBest > streak && ` · 最长 ${streakBest} 天`}
          </p>
        </div>
      </div>
    );
  }

  const progress = need > 0 ? Math.min(1, have / need) : 1;

  return (
    <div className="inset-group p-4">
      <div className="flex items-center gap-3.5">
        <span
          className={`relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors ${
            canCheckin ? "bg-[var(--accent)]" : "bg-[var(--fill)]"
          }`}
        >
          <Sparkles
            className={`h-5 w-5 ${canCheckin ? "text-[var(--accent-ink)]" : "text-[var(--ink-tertiary)]"} ${
              celebrating ? "animate-ping" : ""
            }`}
            strokeWidth={2}
            aria-hidden
          />
        </span>

        <div className="min-w-0 flex-1">
          <p className="t-body leading-tight">{canCheckin ? "可以打卡了" : "今日打卡"}</p>
          <p className="t-caption mt-0.5 text-[var(--ink-tertiary)]">
            {canCheckin ? `连胜 ${streak} 天，继续保持` : message}
          </p>
        </div>

        <button
          type="button"
          disabled={!canCheckin || pending}
          onClick={run}
          className={`t-subhead shrink-0 rounded-[var(--radius-control)] px-4 py-2 font-medium transition active:scale-[0.97] ${
            canCheckin
              ? "bg-[var(--accent)] text-[var(--accent-ink)]"
              : "bg-[var(--fill)] text-[var(--ink-tertiary)]"
          }`}
        >
          {pending ? "…" : "打卡"}
        </button>
      </div>

      {/* 差多少就画多少，比一个灰按钮有用得多 */}
      {!canCheckin && need > 0 && (
        <div className="mt-3">
          <div className="h-1 overflow-hidden rounded-full bg-[var(--fill)]">
            <div
              className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-500"
              style={{ width: `${progress * 100}%` }}
            />
          </div>
          <p className="tabular t-caption2 mt-1.5 text-[var(--ink-quaternary)]">
            今天已有 {have} 条高质量发言，还差 {Math.max(0, need - have)} 条
          </p>
        </div>
      )}
    </div>
  );
}
