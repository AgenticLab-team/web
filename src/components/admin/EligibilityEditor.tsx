"use client";

import { useState, useTransition } from "react";

import { previewEligibility } from "@/lib/activities/preview-action";
import { METRIC_LABELS, type Rule } from "@/lib/activities/eligibility";

/**
 * 资格规则编辑器。
 *
 * **核心是右边那个数字。** 规则调一格，「现在有 N 人够格」立刻重算 ——
 * 60 个名额，是 500 人抢还是只有 12 个人合格，
 * 这两种情况的应对完全相反，而这个数必须在开放前拿到。
 *
 * 另外列出「差一点点」的人：门槛从 50 降到 40 能多放进来几个，
 * 这个具体数字比任何讨论都有说服力。
 */

interface Condition {
  metric: string;
  op: ">=" | "<=";
  value: string;
}

const COMMON_METRICS = [
  "quality_messages",
  "messages",
  "level",
  "active_days",
  "streak",
  "forum_posts",
  "points_total",
] as const;

export function EligibilityEditor({
  value,
  onChange,
}: {
  value: Rule | null;
  onChange: (rule: Rule | null) => void;
}) {
  const [conditions, setConditions] = useState<Condition[]>(() => fromRule(value));
  const [preview, setPreview] = useState<{
    total: number;
    eligible: number;
    nearMiss: { name: string; missing: string }[];
  } | null>(null);
  const [pending, startTransition] = useTransition();

  const push = (next: Condition[]) => {
    setConditions(next);
    onChange(toRule(next));
    // 改一下就重算 —— 这是这个编辑器存在的理由
    startTransition(async () => {
      const result = await previewEligibility(toRule(next));
      if (result.ok) setPreview(result.preview!);
    });
  };

  return (
    <div className="space-y-2.5 rounded-[var(--radius-card)] bg-[var(--fill)] p-3.5">
      <div className="flex items-baseline justify-between">
        <p className="t-caption2 font-medium uppercase tracking-[0.06em] text-[var(--ink-quaternary)]">
          谁能参加
        </p>
        {preview && (
          <p className="t-subhead">
            <span className="tabular font-medium">{preview.eligible}</span>
            <span className="t-caption text-[var(--ink-tertiary)]"> / {preview.total} 人够格</span>
          </p>
        )}
      </div>

      {conditions.length === 0 && (
        <p className="t-caption text-[var(--ink-tertiary)]">
          没有条件 = 人人可参加。这是明确的设置，不是遗漏。
        </p>
      )}

      {conditions.map((c, i) => (
        <div key={i} className="flex gap-1.5">
          <select
            value={c.metric}
            onChange={(e) => push(conditions.map((x, j) => (j === i ? { ...x, metric: e.target.value } : x)))}
            className={`t-subhead flex-1 ${inputClass}`}
          >
            {COMMON_METRICS.map((m) => (
              <option key={m} value={m}>
                {METRIC_LABELS[m]}
              </option>
            ))}
          </select>

          <select
            value={c.op}
            onChange={(e) =>
              push(conditions.map((x, j) => (j === i ? { ...x, op: e.target.value as ">=" } : x)))
            }
            className={`t-subhead w-20 ${inputClass}`}
          >
            <option value=">=">至少</option>
            <option value="<=">至多</option>
          </select>

          <input
            type="number"
            value={c.value}
            onChange={(e) => push(conditions.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
            className={`tabular w-24 ${inputClass}`}
          />

          <button
            type="button"
            onClick={() => push(conditions.filter((_, j) => j !== i))}
            aria-label="删掉这条"
            className="t-subhead shrink-0 rounded-[var(--radius-control)] px-2.5 text-[var(--ink-quaternary)]"
          >
            ×
          </button>
        </div>
      ))}

      <button
        type="button"
        onClick={() => push([...conditions, { metric: "quality_messages", op: ">=", value: "50" }])}
        className="t-caption rounded-[var(--radius-pill)] bg-[var(--surface)] px-2.5 py-1 text-[var(--ink-secondary)]"
      >
        加一条
      </button>

      {/* 「差一点点」的人 —— 门槛降一格能多放进来几个，这比任何讨论都有说服力 */}
      {preview && preview.nearMiss.length > 0 && (
        <div className="space-y-0.5 pt-1">
          <p className="t-caption2 text-[var(--ink-quaternary)]">
            差一点点的 {preview.nearMiss.length} 人（门槛松一格就能进来）
          </p>
          {preview.nearMiss.map((n) => (
            <p key={n.name} className="t-caption2 text-[var(--ink-tertiary)]">
              · {n.name}：{n.missing}
            </p>
          ))}
        </div>
      )}

      {pending && <p className="t-caption2 text-[var(--ink-quaternary)]">重算中…</p>}
    </div>
  );
}

function fromRule(rule: Rule | null): Condition[] {
  if (!rule) return [];
  const list = "all" in rule ? rule.all : [rule];
  return list
    .filter((r): r is Extract<Rule, { metric: string }> => "metric" in r)
    .map((r) => ({
      metric: r.metric,
      op: (r.op === "<=" ? "<=" : ">=") as ">=" | "<=",
      value: String(r.value),
    }));
}

function toRule(conditions: Condition[]): Rule | null {
  const valid = conditions.filter((c) => c.value.trim() !== "" && Number.isFinite(Number(c.value)));
  if (valid.length === 0) return null;

  const rules: Rule[] = valid.map((c) => ({
    metric: c.metric,
    op: c.op,
    value: Number(c.value),
  }));

  return rules.length === 1 ? rules[0] : { all: rules };
}

const inputClass =
  "rounded-[var(--radius-control)] bg-[var(--surface)] px-2.5 py-1.5 outline-none";
