"use client";

import { RotateCcw, Undo2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  AdminButton,
  AdminConfirm,
  AdminRow,
  AdminTag,
  adminFieldClass,
} from "@/components/admin/ui";
import { revertLedgerEntry } from "@/lib/points/admin-actions";
import type { LedgerRow } from "@/lib/points/admin";

/**
 * 全站积分流水。
 *
 * ─────────────────────────────────────────
 * 一眼要能分出「谁给的」
 * ─────────────────────────────────────────
 *
 * 流水里混着三种来源：规则自动发的、用户之间打赏转的、
 * 管理员手动调的。前两种是系统在按规矩办事，第三种是有人**绕过了规矩** ——
 * 而排查问题时先看的永远是第三种。
 *
 * 所以人工那几条要在一列灰字里跳出来，而不是靠读理由才发现。
 */
export function LedgerTable({ rows }: { rows: LedgerRow[] }) {
  if (rows.length === 0) {
    /* 空态和后台其它二十处一样：一句结论 + 一句下一步。
       原来只有孤零零的一句「没有符合条件的流水」，
       人不知道是筛窄了还是真的没有 */
    return (
      <div className="inset-group px-6 py-10 text-center">
        <p className="t-callout text-[var(--ink-secondary)]">没有符合条件的流水</p>
        <p className="t-footnote mx-auto mt-1.5 max-w-sm text-[var(--ink-tertiary)]">
          换个关键词，或者把上面的筛选切回「全部」
        </p>
      </div>
    );
  }

  return (
    <div className="inset-group">
      {rows.map((row) => (
        <Row key={row.id} row={row} />
      ))}
    </div>
  );
}

function Row({ row }: { row: LedgerRow }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const manual = Boolean(row.operatorId) && row.operatorId !== "system";
  const isReversal = Boolean(row.revertsId);
  const wasReverted = Boolean(row.revertedBy);

  return (
    <AdminRow align="start" className="flex-col">
      <div className="flex w-full items-start gap-3">
        {/*
          * 金额靠左第一眼。正负用颜色分 ——
          * 一列数字里找负号比找颜色慢得多。
          */}
        <span
          className={`tabular t-body w-16 shrink-0 text-right font-medium ${
            row.delta > 0 ? "text-[var(--success)]" : "text-[var(--danger)]"
          }`}
        >
          {row.delta > 0 ? "+" : ""}
          {row.delta}
        </span>

        <div className="min-w-0 flex-1">
          <p className="t-subhead flex flex-wrap items-center gap-1.5">
            <Link
              href={`/admin/users/${row.userId}`}
              className="font-medium hover:underline"
            >
              {row.name}
            </Link>
            {manual && <AdminTag color="var(--warning)">人工 · {row.operatorName}</AdminTag>}
            {isReversal && (
              <AdminTag className="inline-flex items-center gap-0.5">
                <Undo2 className="h-3 w-3" strokeWidth={2} aria-hidden />
                冲正
              </AdminTag>
            )}
            {wasReverted && (
              <span className="t-caption2 text-[var(--ink-quaternary)]">已被冲正</span>
            )}
          </p>
          <p className="t-caption mt-0.5 text-[var(--ink-tertiary)]">{row.reason}</p>
          <p className="tabular t-caption2 mt-0.5 text-[var(--ink-quaternary)]">
            余额 {row.balanceAfter} · {new Date(row.createdAt).toLocaleString("zh-CN", { hour12: false })}
          </p>
        </div>

        {/*
          * 冲正过的、以及本身就是冲正的，都不给再冲一次的入口。
          * 服务端也挡着（revertPoints 判 revertedBy），这里是不让人白点。
          */}
        {!wasReverted && !isReversal && !confirming && (
          <AdminButton
            tone="quiet"
            size="sm"
            onClick={() => setConfirming(true)}
            title="冲正这一笔"
            aria-label={`冲正 ${row.name} 的这笔 ${row.delta > 0 ? "+" : ""}${row.delta}`}
            className="hover:text-[var(--danger)]"
          >
            <RotateCcw className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          </AdminButton>
        )}
      </div>

      {confirming && (
        <AdminConfirm
          title="冲正这一笔？"
          confirmLabel="确认冲正"
          disabled={pending || reason.trim().length < 4}
          onCancel={() => setConfirming(false)}
          onConfirm={() =>
            startTransition(async () => {
              const r = await revertLedgerEntry(row.id, reason);
              if (!r.ok) setError(r.error ?? "没成功");
              else {
                setConfirming(false);
                router.refresh();
              }
            })
          }
        >
          <p className="t-caption leading-relaxed text-[var(--ink-secondary)]">
            会给 {row.name} 写一条 {row.delta > 0 ? "−" : "+"}
            {Math.abs(row.delta)} 的反向流水，原记录保持不动。
          </p>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="为什么要冲正？（至少四个字，会留在当事人的账单里）"
            className={adminFieldClass}
          />
        </AdminConfirm>
      )}

      {error && (
        <p role="alert" className="t-caption text-[var(--danger)]">
          {error}
        </p>
      )}
    </AdminRow>
  );
}
