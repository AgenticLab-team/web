"use client";

import { AlertTriangle, Calculator, CheckCircle2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { cancelRecount, executeRecount, previewRecount } from "@/lib/points/recount-actions";
import type { RecountPlan } from "@/lib/points/recount-rules";

/**
 * 积分重算。
 *
 * ─────────────────────────────────────────
 * 先预览，再执行 —— 两步之间要看得见东西
 * ─────────────────────────────────────────
 *
 * 这个按钮会改所有人的余额。一个「重算」按钮点下去直接跑完，
 * 是把一个不可逆的操作做成了一次点击。
 *
 * 所以预览摆出三个数：多少人会改、余额净增减多少、多少人等级会变。
 * **净增减不为 0 本身就是信息** —— 它说明之前有人直接改过库。
 */
export function RecountPanel({ pending: pendingTask }: { pending: { id: string; preview: unknown } | null }) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const [plan, setPlan] = useState<RecountPlan | null>(null);
  const [taskId, setTaskId] = useState<string | null>(pendingTask?.id ?? null);
  const [wide, setWide] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) setError(r.error ?? "没成功");
      else setError(null);
      router.refresh();
    });

  return (
    <div className="inset-group p-4">
      <p className="t-subhead flex items-center gap-1.5 font-medium">
        <Calculator className="h-4 w-4 text-[var(--ink-tertiary)]" strokeWidth={2} aria-hidden />
        按流水重算余额
      </p>
      <p className="t-caption mt-1 leading-relaxed text-[var(--ink-tertiary)]">
        以流水为准重算余额。上面的风控队列报「对不上账」时，从这里修 ——
        直接改库正是造成对不上账的原因。
      </p>

      {!taskId && !done && (
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            startTransition(async () => {
              const r = await previewRecount();
              if (!r.ok) {
                setError(r.error ?? "没成功");
                return;
              }
              setPlan(r.plan ?? null);
              setTaskId(r.taskId ?? null);
              setWide(Boolean(r.wide));
              setNote(r.note ?? null);
              setError(null);
            })
          }
          className="t-caption mt-2.5 rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-1.5 font-medium transition active:scale-95 disabled:opacity-50"
        >
          先算一遍看看
        </button>
      )}

      {taskId && !done && (
        <div className="mt-3 rounded-[var(--radius-control)] bg-[var(--fill)] p-3">
          <p className="t-subhead font-medium">{note ?? "已经算好，等你确认"}</p>

          {plan && plan.rows.length > 0 && (
            <div className="mt-2 grid grid-cols-3 gap-2">
              <Stat label="要改的账号" value={plan.rows.length} />
              <Stat label="余额净增减" value={`${plan.netDelta > 0 ? "+" : ""}${plan.netDelta}`} />
              <Stat label="等级会变" value={plan.levelChanges} />
            </div>
          )}

          {/*
            * 改动面太大时先问一句。
            *
            * 正常情况下重算只该动几个人 —— 那是某次直接改库留下的痕迹。
            * 要动一半以上的话，更可能是流水本身出了问题，
            * 而这时候按流水重写缓存会把所有人的分抹掉。
            */}
          {wide && (
            <p className="t-caption mt-2 flex items-start gap-1.5 leading-relaxed text-[var(--danger)]">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={2.2} aria-hidden />
              这次会动一半以上的账号 —— 更可能是流水本身缺了一批。
              先确认流水完整再执行，否则会把所有人的分抹掉。
            </p>
          )}

          {plan && plan.rows.length > 0 && (
            <details className="mt-2">
              <summary className="t-caption cursor-pointer text-[var(--ink-tertiary)]">
                看看具体是哪些账号
              </summary>
              <ul className="mt-1.5 max-h-48 space-y-0.5 overflow-y-auto">
                {plan.rows.slice(0, 50).map((row) => (
                  <li key={row.userId} className="tabular t-caption2 text-[var(--ink-secondary)]">
                    {row.userId.slice(-6)} · 余额 {row.points.from} → {row.points.to}
                    {row.level.from !== row.level.to && ` · L${row.level.from} → L${row.level.to}`}
                  </li>
                ))}
                {plan.rows.length > 50 && (
                  <li className="t-caption2 text-[var(--ink-quaternary)]">
                    还有 {plan.rows.length - 50} 个没列出来
                  </li>
                )}
              </ul>
            </details>
          )}

          <div className="mt-2.5 flex items-center gap-2">
            <button
              type="button"
              disabled={busy || (plan?.rows.length ?? 0) === 0}
              onClick={() =>
                startTransition(async () => {
                  const r = await executeRecount(taskId);
                  if (!r.ok) setError(r.error ?? "没成功");
                  else {
                    setDone(true);
                    setNote(r.note ?? null);
                    setError(null);
                    router.refresh();
                  }
                })
              }
              className="t-caption rounded-[var(--radius-control)] bg-[var(--accent)] px-3 py-1.5 font-medium text-[var(--accent-ink)] transition active:scale-95 disabled:opacity-40"
            >
              执行
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const r = await cancelRecount(taskId);
                  if (r.ok) {
                    setTaskId(null);
                    setPlan(null);
                  }
                  return r;
                })
              }
              className="t-caption px-2 py-1.5 text-[var(--ink-tertiary)]"
            >
              算了
            </button>
          </div>

          {/*
            * 执行时会**重新算一遍**，不吃预览那份 ——
            * 预览和确认之间那段时间里分还在照常发。说出来，
            * 否则人会以为上面那几个数就是最终会落库的数。
            */}
          <p className="t-caption2 mt-2 text-[var(--ink-quaternary)]">
            执行时会重新算一遍（这中间可能又有人拿到分），所以最终数字可能和上面略有出入。
          </p>
        </div>
      )}

      {done && (
        <p className="t-caption mt-2.5 flex items-center gap-1.5 text-[var(--success)]">
          <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2.2} aria-hidden />
          {note ?? "重算完成"}
        </p>
      )}

      {error && <p className="t-caption mt-2 text-[var(--danger)]">{error}</p>}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-[var(--radius-control)] bg-[var(--surface)] px-2.5 py-2">
      <p className="t-caption2 text-[var(--ink-tertiary)]">{label}</p>
      <p className="tabular t-headline mt-0.5">{value}</p>
    </div>
  );
}
