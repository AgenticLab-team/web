"use client";

import { Flame, MessageSquare, PenLine, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { useToast } from "@/components/ui/Toast";
import { checkinAction } from "@/lib/points/actions";

/**
 * 打卡卡片。
 *
 * 三件事必须一眼看明白，否则用户第二天不会再来：
 *
 *   1. **今天要做什么才能打卡** —— 两条路（群里发言 / 论坛活跃）
 *      各画一条进度条，谁更近谁在前。按钮灰掉不说原因是最劝退的做法。
 *   2. **打了能拿多少** —— 分数明细摊开，而不是打完弹一个数字。
 *      看不懂分怎么来的，就不会为它做事。
 *   3. **今天还剩多少额度** —— 每日发行上限是共享的，
 *      不提前说清楚，撞顶那天会觉得系统在克扣。
 */

export interface CheckinPath {
  kind: "chat" | "forum";
  label: string;
  have: number;
  need: number;
}

export function CheckinCard({
  canCheckin,
  checkedToday,
  message,
  paths,
  streak,
  streakBest,
  budgetRemaining,
  budgetCap,
  preview,
}: {
  canCheckin: boolean;
  checkedToday: boolean;
  message: string;
  paths: CheckinPath[];
  streak: number;
  streakBest: number;
  budgetRemaining: number;
  budgetCap: number;
  /** 现在打卡预计能拿多少分，摊开给用户看 */
  preview: { label: string; points: number }[];
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
        message: result.cappedOut
          ? `连胜 ${result.streak} 天 · 今日积分已达上限`
          : result.leveledUp
            ? `+${result.awarded} 分 · 升到 L${result.leveledUp.to} 了`
            : `+${result.awarded} 分 · 连胜 ${result.streak} 天`,
        kind: "success",
      });
      router.refresh();
    });
  };

  const total = preview.reduce((sum, p) => sum + p.points, 0);

  if (checkedToday) {
    return (
      <div className="inset-group p-4">
        <div className="flex items-center gap-3.5">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)]">
            <Flame className="h-5 w-5 text-[var(--accent)]" strokeWidth={2} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="t-body leading-tight">今天已打卡</p>
            <p className="tabular t-caption mt-0.5 text-[var(--ink-tertiary)]">
              连胜 {streak} 天{streakBest > streak && ` · 最长 ${streakBest} 天`}
            </p>
          </div>
          <StreakDots streak={streak} />
        </div>
        <BudgetBar remaining={budgetRemaining} cap={budgetCap} />
      </div>
    );
  }

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
            {canCheckin
              ? total > 0
                ? `连胜 ${streak} 天 · 现在打卡 +${total} 分`
                : `连胜 ${streak} 天`
              : message}
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

      {/*
        两条路都画出来。只画一条的话，论坛用户会以为自己没资格打卡 ——
        而他们恰恰是沉淀内容最多的那批人。
      */}
      {!canCheckin && (
        <div className="mt-3.5 space-y-2.5">
          {paths.map((path, i) => (
            <PathBar key={path.kind} path={path} dimmed={i > 0} />
          ))}
          <p className="t-caption2 text-[var(--ink-quaternary)]">两条任满一条即可打卡</p>
        </div>
      )}

      {canCheckin && preview.length > 0 && (
        <ul className="mt-3.5 space-y-1">
          {preview.map((row) => (
            <li key={row.label} className="flex items-baseline justify-between">
              <span className="t-caption text-[var(--ink-tertiary)]">{row.label}</span>
              <span className="tabular t-caption text-[var(--ink-secondary)]">+{row.points}</span>
            </li>
          ))}
        </ul>
      )}

      <BudgetBar remaining={budgetRemaining} cap={budgetCap} />
    </div>
  );
}

function PathBar({ path, dimmed }: { path: CheckinPath; dimmed: boolean }) {
  const ratio = path.need > 0 ? Math.min(1, path.have / path.need) : 1;
  const gap = Math.max(0, path.need - path.have);
  const Icon = path.kind === "chat" ? MessageSquare : PenLine;

  return (
    <div className={dimmed ? "opacity-55" : undefined}>
      <div className="mb-1 flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5 text-[var(--ink-tertiary)]" strokeWidth={2} aria-hidden />
        <span className="t-caption text-[var(--ink-secondary)]">{path.label}</span>
        <span className="tabular t-caption2 ml-auto text-[var(--ink-quaternary)]">
          {gap === 0 ? "已达标" : `还差 ${gap}`}
        </span>
      </div>
      <div
        className="h-1 overflow-hidden rounded-full bg-[var(--fill)]"
        role="progressbar"
        aria-valuenow={path.have}
        aria-valuemin={0}
        aria-valuemax={path.need}
        aria-label={path.label}
      >
        <div
          className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-500"
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
    </div>
  );
}

/**
 * 今日额度。
 *
 * 只在快用完时才显示 —— 额度充足时提这件事，
 * 反而会让人觉得「原来还有上限」，那是没必要的心理负担。
 */
function BudgetBar({ remaining, cap }: { remaining: number; cap: number }) {
  if (cap <= 0 || remaining > cap * 0.34) return null;

  return (
    <p className="tabular t-caption2 mt-3 text-[var(--ink-quaternary)]">
      {remaining <= 0
        ? `今天的积分已经拿满了（每日上限 ${cap} 分），明天再来`
        : `今日还可获得 ${remaining} 分（上限 ${cap}）`}
    </p>
  );
}

/** 连胜点阵。看得见的连续比数字更让人不想断 */
function StreakDots({ streak }: { streak: number }) {
  const dots = Math.min(7, streak);
  return (
    <span className="flex shrink-0 gap-1" aria-hidden>
      {Array.from({ length: 7 }, (_, i) => (
        <span
          key={i}
          className={`h-1.5 w-1.5 rounded-full ${
            i < dots ? "bg-[var(--accent)]" : "bg-[var(--fill)]"
          }`}
        />
      ))}
    </span>
  );
}
