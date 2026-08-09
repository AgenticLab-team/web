"use client";

import { CalendarPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { useToast } from "@/components/ui/Toast";
import { spendMakeupCard } from "@/lib/points/makeup-actions";
import type { MakeupCandidate } from "@/lib/points/makeup-rules";

/**
 * 补签。
 *
 * ─────────────────────────────────────────
 * 每一天都要标出「补完连胜是多少」
 * ─────────────────────────────────────────
 *
 * 只列日期的话，人得自己在脑子里推一遍哪天补了能接上 ——
 * 而那正是他最容易算错、事后最容易觉得被坑了的地方。
 * 一张卡花了两百分，补错一天等于白花。
 *
 * 所以每一天后面写着补完之后连胜会变成多少，**而且默认选中收益最大的那天**。
 */
export function MakeupPanel({
  cards,
  candidates,
  streak,
  usedThisMonth,
  monthlyLimit,
}: {
  cards: number;
  candidates: MakeupCandidate[];
  streak: number;
  usedThisMonth: number;
  monthlyLimit: number;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  // 收益最大的那天默认选中 —— 多数人要的就是它
  const best = candidates.reduce<MakeupCandidate | null>(
    (a, b) => (a && a.streakAfter >= b.streakAfter ? a : b),
    null,
  );
  const [picked, setPicked] = useState<string | null>(best?.date ?? null);

  if (cards <= 0) return null;

  const limited = monthlyLimit > 0 && usedThisMonth >= monthlyLimit;

  return (
    <div className="inset-group p-4">
      <p className="t-subhead flex items-center gap-1.5 font-medium">
        <CalendarPlus className="h-4 w-4 text-[var(--ink-tertiary)]" strokeWidth={2} aria-hidden />
        补签卡 · {cards} 张
      </p>

      {candidates.length === 0 ? (
        /*
         * 没有可补的日子时说清楚是「没断过」，不是「功能坏了」。
         * 这一句是这一整块最容易被读成故障的状态。
         */
        <p className="t-caption mt-1.5 leading-relaxed text-[var(--ink-tertiary)]">
          最近七天你一天都没落下，暂时用不上 —— 卡留着，断签那天再来。
        </p>
      ) : limited ? (
        <p className="t-caption mt-1.5 leading-relaxed text-[var(--ink-tertiary)]">
          这个月已经补过 {usedThisMonth} 次了（上限 {monthlyLimit}）。下个月可以再补。
        </p>
      ) : (
        <>
          <p className="t-caption mt-1.5 leading-relaxed text-[var(--ink-tertiary)]">
            现在连胜 {streak} 天。补哪天：
          </p>

          <div className="mt-2 space-y-1">
            {candidates.map((c) => {
              const gain = c.streakAfter - streak;
              return (
                <button
                  key={c.date}
                  type="button"
                  onClick={() => setPicked(c.date)}
                  aria-pressed={picked === c.date}
                  className={`tap-target flex w-full items-center gap-2 rounded-[var(--radius-control)] px-3 py-2 text-left transition-colors ${
                    picked === c.date
                      ? "bg-[color-mix(in_srgb,var(--accent)_12%,transparent)]"
                      : "bg-[var(--fill)]"
                  }`}
                >
                  <span className="t-subhead tabular flex-1">{c.date}</span>
                  <span className="t-caption text-[var(--ink-tertiary)]">
                    连胜 → {c.streakAfter} 天
                  </span>
                  {/* 收益为 0 的那些也列出来但标出来 —— 藏起来的话，
                      人会以为那天不能补，然后来问为什么 */}
                  {gain > 0 ? (
                    <span className="t-caption2 font-medium text-[var(--success)]">+{gain}</span>
                  ) : (
                    <span className="t-caption2 text-[var(--ink-quaternary)]">接不上</span>
                  )}
                </button>
              );
            })}
          </div>

          <button
            type="button"
            disabled={pending || !picked}
            onClick={() =>
              startTransition(async () => {
                if (!picked) return;
                const r = await spendMakeupCard(picked);
                toast.show(
                  r.ok
                    ? { message: r.note, kind: "success" }
                    : { message: r.error, kind: "error" },
                );
                if (r.ok) router.refresh();
              })
            }
            className="t-subhead mt-3 w-full rounded-[var(--radius-control)] bg-[var(--accent)] px-4 py-2.5 font-medium text-[var(--accent-ink)] transition active:scale-[0.99] disabled:opacity-40"
          >
            用一张补上 {picked ?? ""}
          </button>

          {/*
            * 说清楚它不给分。
            *
            * 不说的话，一个花两百分买卡的人会以为能拿回当天那几分 ——
            * 而他其实买的是连胜。事后才发现的话，
            * 他会觉得这张卡骗了他。
            */}
          <p className="t-caption2 mt-2 leading-relaxed text-[var(--ink-quaternary)]">
            补签只接回连胜，不补发那天的积分。
          </p>
        </>
      )}
    </div>
  );
}
