"use client";

import { useState, useTransition } from "react";

import { runMirrorAudit } from "@/lib/admin/mirror-actions";
import type { MirrorAudit as Audit } from "@/lib/admin/mirror-audit";

/**
 * 镜像对账。
 *
 * ─────────────────────────────────────────
 * 它回答的是「归档缺的那一段该不该去补」
 * ─────────────────────────────────────────
 *
 * 本地少了 = 同步漏了，能补也必须补（上游随时会清历史）。
 * 上游本来就没有 = 那几天没在采集，补不了。
 *
 * 两者在站里长得一模一样，而要做的事完全相反。
 */
export function MirrorAudit() {
  const [audit, setAudit] = useState<Audit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const run = () =>
    start(async () => {
      setError(null);
      const result = await runMirrorAudit();
      if (result.ok) setAudit(result.audit);
      else {
        setAudit(null);
        setError(result.error);
      }
    });

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="t-subhead font-medium">和上游对账</p>
          <p className="t-caption mt-0.5 leading-relaxed text-[var(--ink-tertiary)]">
            逐群比「本地有多少条」和「上游有多少条」。
            归档缺一段时，这里能分清是同步漏了（能补）还是上游本来就没有（补不了）。
          </p>
        </div>
        <button
          type="button"
          onClick={run}
          disabled={pending}
          className="t-caption shrink-0 rounded-[var(--radius-pill)] bg-[var(--fill)] px-3 py-1.5 font-medium text-[var(--ink)] transition disabled:opacity-40"
        >
          {pending ? "问上游中…" : "现在对账"}
        </button>
      </div>

      {error && (
        <p className="t-caption mt-2.5 text-[var(--danger)]">
          {/* 失败就说失败 —— 不能显示一份「全部正常」的空对账 */}
          对账没跑成：{error}
        </p>
      )}

      {audit && (
        <div className="mt-3">
          <p
            className="t-caption mb-2"
            style={{
              color:
                audit.behind > 0
                  ? "var(--danger)"
                  : audit.unknown > 0
                    ? "var(--warning)"
                    : "var(--success)",
            }}
          >
            {audit.behind > 0
              ? `${audit.behind} 个群本地比上游少 —— 这部分能补，跑一次同步`
              : audit.unknown > 0
                ? `${audit.unknown} 个群没问到上游，其余一致`
                : "逐群一条不差 —— 本地是上游的完整镜像"}
          </p>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[22rem] border-collapse">
              <thead>
                <tr className="t-caption2 text-[var(--ink-tertiary)]">
                  <th className="py-1 text-left font-normal">群</th>
                  <th className="py-1 text-right font-normal">本地</th>
                  <th className="py-1 text-right font-normal">上游</th>
                  <th className="py-1 text-right font-normal">差</th>
                </tr>
              </thead>
              <tbody>
                {audit.rows.map((row) => (
                  <tr key={row.convId} className="hairline-t">
                    <td className="t-caption max-w-[10rem] truncate py-1.5 pr-2">{row.name}</td>
                    <td className="t-caption py-1.5 text-right tabular-nums">
                      {row.local.toLocaleString("zh-CN")}
                    </td>
                    <td className="t-caption py-1.5 text-right tabular-nums text-[var(--ink-secondary)]">
                      {row.upstream === null ? "问不到" : row.upstream.toLocaleString("zh-CN")}
                    </td>
                    <td
                      className="t-caption py-1.5 text-right tabular-nums"
                      style={{
                        color:
                          row.status === "behind"
                            ? "var(--danger)"
                            : row.status === "ok"
                              ? "var(--ink-tertiary)"
                              : "var(--ink-secondary)",
                      }}
                    >
                      {/*
                        本地比上游多不是错：上游会裁剪历史，
                        而本地留着那些老消息正是这个站存在的理由之一。
                        所以只有「少」染红。
                      */}
                      {row.delta === null ? "—" : row.delta === 0 ? "一致" : `${row.delta > 0 ? "+" : ""}${row.delta}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
