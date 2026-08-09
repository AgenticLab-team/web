import { Check } from "lucide-react";

import type { RuleOutcome } from "@/lib/activities/eligibility";

/**
 * 「你离够格还差多少」。
 *
 * ─────────────────────────────────────────
 * 一行小字换成一条进度条
 * ─────────────────────────────────────────
 *
 * 原来写的是「高质量发言只有 12，要求至少 20」。
 * 那句话是对的，但它在手机上是一行会被略过的灰字 ——
 * 而这是整个活动里人**最想知道**的一件事。
 *
 * 一条进度条把「差多少」变成一眼可见的长度，
 * 顺带回答了那个更要紧的问题：这事我够得着吗。
 *
 * ─────────────────────────────────────────
 * 「满足其一」要把每条路分开画
 * ─────────────────────────────────────────
 *
 * 域名活动现在有两条路：群里 20 条高质量发言，或者
 * 在论坛认真写一篇。折叠成一句话的话，人得自己在长句子里
 * 找哪条最接近 —— 而那正是他唯一想知道的事。
 */
export function EligibilityBars({ outcomes }: { outcomes: RuleOutcome[] }) {
  return (
    <ul className="mt-3 space-y-2.5">
      {outcomes.map((outcome, i) => (
        <li key={i}>
          {outcome.anyOf ? (
            <div>
              <p className="t-caption2 text-[var(--ink-tertiary)]">{outcome.message}</p>
              <ul className="mt-1.5 space-y-2">
                {outcome.anyOf.map((branch, j) => (
                  <li key={j} className="flex items-start gap-1.5">
                    {/* 竖线把「这几条是并列的选择」画出来，比缩进更清楚 */}
                    <span
                      className="mt-1 w-0.5 shrink-0 self-stretch rounded-full"
                      style={{
                        background: branch.passed ? "var(--success)" : "var(--separator)",
                      }}
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <Bar outcome={branch} />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <Bar outcome={outcome} />
          )}
        </li>
      ))}
    </ul>
  );
}

function Bar({ outcome }: { outcome: RuleOutcome }) {
  const hasProgress =
    typeof outcome.current === "number" && typeof outcome.target === "number" && outcome.target > 0;

  const pct = hasProgress
    ? Math.min(100, Math.round((outcome.current! / outcome.target!) * 100))
    : outcome.passed
      ? 100
      : 0;

  return (
    <div>
      <p
        className="t-caption2 flex items-center gap-1"
        style={{ color: outcome.passed ? "var(--ink-tertiary)" : "var(--ink-secondary)" }}
      >
        {outcome.passed && (
          <Check
            className="h-3 w-3 shrink-0"
            style={{ color: "var(--success)" }}
            strokeWidth={2.4}
            aria-hidden
          />
        )}
        <span className="min-w-0 flex-1">{outcome.message}</span>
        {hasProgress && (
          <span className="tabular shrink-0 text-[var(--ink-tertiary)]">
            {outcome.current} / {outcome.target}
          </span>
        )}
      </p>

      {/*
        * 达标之后进度条留着，不撤掉。
        *
        * 撤掉的话，够格的人看到的是一句孤零零的「达标」，
        * 而不知道自己是怎么达标的、超出多少 —— 也就不知道要保持什么。
        */}
      <div
        className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--fill)]"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={outcome.message}
      >
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{
            width: `${pct}%`,
            background: outcome.passed ? "var(--success)" : "var(--accent)",
          }}
        />
      </div>
    </div>
  );
}

/**
 * 名额用了多少。
 *
 * 和上面那条不是一回事：那条是「我够不够格」，这条是「还抢不抢得到」。
 * 两个都要有 —— 只有第一条的话，一个够格的人会以为随时可以来。
 */
export function QuotaBar({ used, total }: { used: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const left = Math.max(0, total - used);
  // 剩不到两成时变色 —— 那时候「还有名额」和「快没了」是两件事
  const tight = left <= Math.max(1, Math.round(total * 0.2));

  return (
    <div className="mt-2">
      <p className="t-caption2 flex items-center justify-between text-[var(--ink-tertiary)]">
        <span>名额</span>
        <span className="tabular" style={tight ? { color: "var(--warning)" } : undefined}>
          {left === 0 ? "已经发完" : `还剩 ${left} 个`}
          <span className="text-[var(--ink-quaternary)]">
            {" "}
            / 共 {total}
          </span>
        </span>
      </p>
      <div
        className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--fill)]"
        role="progressbar"
        aria-valuenow={used}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-label={`名额 ${used} / ${total}`}
      >
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{
            width: `${pct}%`,
            background: tight ? "var(--warning)" : "var(--accent)",
          }}
        />
      </div>
    </div>
  );
}
