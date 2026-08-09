"use client";

import { useState, useTransition } from "react";

import { runEnrichAction } from "@/lib/links/enrich-actions";

/**
 * 在后台点一下就整理一批。
 *
 * 一次只跑一小批（默认 30 条）而不是整库：整库要几分钟，
 * 而一个转着圈几分钟没反应的按钮，人会以为它卡死了然后刷新页面 ——
 * 刷新之后前一批还在后台跑，于是同一批链接被问两遍。
 */
export function EnrichRunner({ disabled }: { disabled: boolean }) {
  const [result, setResult] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();

  const run = () =>
    startTransition(async () => {
      const report = await runEnrichAction(30);
      setResult(
        report.ok
          ? `扫了 ${report.scanned} 条：写入 ${report.written} · 说不清 ${report.unknown} · 失败 ${report.failed}`
          : report.error,
      );
      setNotes(report.ok ? report.notes : []);
    });

  return (
    <div className="inset-row px-4 py-3">
      <button
        type="button"
        onClick={run}
        disabled={pending || disabled}
        title={disabled ? "对话模型现在不可用，先把上面那一项修好" : undefined}
        className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-[13px] font-medium text-white transition-opacity hover:opacity-85 disabled:opacity-40"
      >
        {pending ? "整理中…（一次 30 条，要等一会儿）" : "整理下一批（30 条）"}
      </button>

      {result && (
        <p role="status" className="t-caption mt-2 text-[var(--ink-secondary)]">
          {result}
        </p>
      )}
      {notes.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {notes.slice(0, 6).map((n) => (
            <li key={n} className="t-caption2 text-[var(--danger)]">
              {n}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
