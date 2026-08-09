"use client";

import { AlertTriangle, Check, Loader2, ShieldQuestion } from "lucide-react";
import { useState, useTransition } from "react";

import {
  cancelPruneTask,
  createPruneTask,
  executePruneTask,
  type PruneActionResult,
} from "@/lib/storage/actions";
import { formatBytes, isIrreversible, isNoop, type PrunePreview } from "@/lib/storage/tiers";

/**
 * 裁剪的两步交互。
 *
 * 第一步只算不改，第二步才动数据。中间那屏是整个功能的重点 ——
 * 它是管理员**唯一一次**能在不可逆操作发生前看清会丢什么的机会。
 *
 * 三条界面规矩：
 *   · 会丢正文时确认按钮换配色、换文案，并且要先勾选
 *   · 什么都不会发生时按钮直接禁用，别让它看起来像会做事
 *   · 「只做可逆步骤」永远摆在旁边 —— 大多数时候那才是想要的
 */
export function PruneRunner({ initialTaskId }: { initialTaskId?: string }) {
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<PruneActionResult | null>(
    initialTaskId ? { ok: true, taskId: initialTaskId } : null,
  );
  const [confirmed, setConfirmed] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const preview = state?.preview;
  const dangerous = preview ? isIrreversible(preview) : false;
  const noop = preview ? isNoop(preview) : false;

  function run(fn: () => Promise<PruneActionResult>, after?: (r: PruneActionResult) => void) {
    startTransition(async () => {
      const result = await fn();
      setState(result);
      after?.(result);
    });
  }

  if (done) {
    return (
      <div
        className="rounded-[var(--radius-card)] p-4 hairline"
        style={{ background: "color-mix(in srgb, var(--success) 9%, var(--surface))" }}
      >
        <p className="t-subhead flex items-center gap-1.5 font-medium" style={{ color: "var(--success)" }}>
          <Check className="h-4 w-4" strokeWidth={2.4} aria-hidden />
          裁剪完成
        </p>
        <p className="t-caption mt-1 leading-relaxed text-[var(--ink-secondary)]">{done}</p>
        <button
          type="button"
          className="t-subhead mt-3 text-[var(--accent)] transition active:opacity-60"
          onClick={() => {
            setDone(null);
            setState(null);
            setConfirmed(false);
          }}
        >
          再算一次
        </button>
      </div>
    );
  }

  if (!preview) {
    return (
      <div>
        <button
          type="button"
          disabled={pending}
          onClick={() => run(createPruneTask)}
          className="t-subhead rounded-[var(--radius-control)] bg-[var(--accent)] px-4 py-2.5 font-medium text-white transition active:opacity-70 disabled:opacity-45"
        >
          {pending ? (
            <span className="flex items-center gap-1.5">
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.2} aria-hidden />
              正在计算
            </span>
          ) : (
            "计算这次会裁掉什么"
          )}
        </button>
        <p className="t-caption mt-2 leading-relaxed text-[var(--ink-tertiary)]">
          只算不改。看清楚之后才有第二步。
        </p>
        {state?.error && (
          <p className="t-caption mt-2" style={{ color: "var(--danger)" }}>
            {state.error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <PreviewCard preview={preview} />

      {state?.warnings?.map((w) => (
        <p key={w} className="t-caption flex gap-1.5 px-1 leading-relaxed" style={{ color: "var(--warning)" }}>
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={2.2} aria-hidden />
          {w}
        </p>
      ))}

      {state?.retention && (
        <p
          className="t-caption flex gap-1.5 px-1 leading-relaxed"
          style={{ color: state.retention.ok ? "var(--ink-secondary)" : "var(--danger)" }}
        >
          <ShieldQuestion className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={2.2} aria-hidden />
          回源验证：{state.retention.reason}
        </p>
      )}

      {dangerous && (
        <label className="flex cursor-pointer items-start gap-2 rounded-[var(--radius-card)] bg-[var(--surface)] p-3.5 hairline">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--danger)]"
          />
          <span className="t-caption leading-relaxed text-[var(--ink-secondary)]">
            我知道这会<strong style={{ color: "var(--danger)" }}>永久丢掉 {preview.drop} 条消息的正文</strong>
            （已归档成文件），从站上再也搜不到、看不到。
          </span>
        </label>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending || noop || (dangerous && !confirmed)}
          onClick={() =>
            run(
              () => executePruneTask({ taskId: state!.taskId! }),
              (r) => r.ok && setDone(r.note ?? "已执行"),
            )
          }
          className="t-subhead rounded-[var(--radius-control)] px-4 py-2.5 font-medium text-white transition active:opacity-70 disabled:opacity-40"
          style={{ background: dangerous ? "var(--danger)" : "var(--accent)" }}
        >
          {pending ? "执行中…" : dangerous ? "归档并裁剪" : "执行裁剪"}
        </button>

        {/* 大多数时候这才是想要的那个按钮 */}
        <button
          type="button"
          disabled={pending || (preview.retier === 0 && preview.unindex === 0)}
          onClick={() =>
            run(
              () => executePruneTask({ taskId: state!.taskId!, reversibleOnly: true }),
              (r) => r.ok && setDone(r.note ?? "已执行"),
            )
          }
          className="t-subhead rounded-[var(--radius-control)] bg-[var(--fill)] px-4 py-2.5 font-medium transition active:opacity-70 disabled:opacity-40"
        >
          只做可逆的部分
        </button>

        <button
          type="button"
          disabled={pending}
          onClick={() =>
            run(
              () => cancelPruneTask(state!.taskId!),
              () => {
                setState(null);
                setConfirmed(false);
              },
            )
          }
          className="t-subhead px-2 py-2.5 text-[var(--ink-tertiary)] transition active:opacity-60"
        >
          取消
        </button>
      </div>

      {noop && (
        <p className="t-caption px-1 text-[var(--ink-tertiary)]">
          当前没有任何消息需要处理 —— 最老的一条还没跨过热层边界。
        </p>
      )}
      {state?.error && (
        <p className="t-caption px-1" style={{ color: "var(--danger)" }}>
          {state.error}
        </p>
      )}
    </div>
  );
}

function PreviewCard({ preview }: { preview: PrunePreview }) {
  return (
    <div className="rounded-[var(--radius-card)] bg-[var(--surface)] p-4 hairline">
      <div className="grid grid-cols-3 gap-3">
        <Metric label="改层" value={preview.retier} hint="只改标记" tone="plain" />
        <Metric
          label="退出搜索"
          value={preview.unindex}
          hint={`约省 ${formatBytes(preview.unindexBytes)} · 可重建`}
          tone="plain"
        />
        <Metric
          label="丢弃正文"
          value={preview.drop}
          hint={
            preview.drop > 0 ? `约省 ${formatBytes(preview.dropBytes)} · 不可逆` : "本次不丢"
          }
          tone={preview.drop > 0 ? "danger" : "plain"}
        />
      </div>

      {preview.oldestTs !== null && preview.newestTs !== null && (
        <p className="t-caption mt-3 border-t border-[var(--separator)] pt-2.5 text-[var(--ink-tertiary)]">
          影响范围：{new Date(preview.oldestTs).toLocaleDateString("zh-CN")} 至{" "}
          {new Date(preview.newestTs).toLocaleDateString("zh-CN")}
        </p>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: number;
  hint: string;
  tone: "plain" | "danger";
}) {
  return (
    <div>
      <p className="t-caption2 text-[var(--ink-tertiary)]">{label}</p>
      <p
        className="tabular t-title3 font-semibold"
        style={{ color: tone === "danger" ? "var(--danger)" : "var(--ink)" }}
      >
        {value.toLocaleString()}
      </p>
      <p className="t-caption2 leading-relaxed text-[var(--ink-quaternary)]">{hint}</p>
    </div>
  );
}
