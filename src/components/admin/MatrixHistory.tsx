"use client";

import { useState, useTransition } from "react";

import { AdminButton, AdminNote, AdminTag, adminFieldClass } from "@/components/admin/ui";
import { previewRollback, rollbackMatrix } from "@/lib/rbac/matrix-actions";
import { stateLabel, type MatrixDiff } from "@/lib/rbac/matrix-edit";

/**
 * 矩阵变更历史与一键回滚。
 *
 * ─────────────────────────────────────────
 * 「一键」是指少按几下，不是指少想一步
 * ─────────────────────────────────────────
 *
 * 回滚在人的心里是安全操作 —— 「回到之前」听起来不会有事。
 * 而它其实和任何一次矩阵改动一样危险:快照拍下之后可能已经过了三天,
 * 期间别人做的调整会被一起抹掉。
 *
 * 所以这里和编辑用同一套节奏:**先看会变成什么样,再写理由,再确认**。
 * 唯一的区别是格子不用自己点。
 */

export interface SnapshotRowView {
  id: string;
  createdAt: number;
  takenByName: string;
  changeCount: number;
  changeSummary: string;
  reason: string;
  isRollback: boolean;
}

export function MatrixHistory({
  rows,
  canRollback,
}: {
  rows: SnapshotRowView[];
  canRollback: boolean;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [diff, setDiff] = useState<MatrixDiff | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const open = (id: string) => {
    setOpenId(id);
    setDiff(null);
    setErrors([]);
    setReason("");
    setDone(null);
    startTransition(async () => {
      const result = await previewRollback(id);
      if (result.ok) setDiff(result.diff);
      else setErrors(result.errors);
    });
  };

  const confirm = (id: string) =>
    startTransition(async () => {
      const result = await rollbackMatrix({ snapshotId: id, reason });
      if (result.ok) {
        setDone(result.diff.summary);
        setOpenId(null);
        setDiff(null);
        setReason("");
      } else {
        setErrors(result.errors);
      }
    });

  if (rows.length === 0) {
    return (
      <div className="inset-group px-4 py-6">
        <p className="t-subhead text-[var(--ink-tertiary)]">
          还没有人改过权限矩阵。第一次保存时会顺手留下一张原始状态的快照 ——
          所以第一次改动也是能回退的。
        </p>
      </div>
    );
  }

  return (
    <div className="inset-group">
      {done && (
        <p
          role="status"
          className="t-subhead border-b border-[var(--separator)] px-4 py-2 text-[var(--success)]"
        >
          已回滚 —— {done}。这次回滚本身也进了历史。
        </p>
      )}

      <ul>
        {rows.map((row) => (
          <li key={row.id} className="border-b border-[var(--separator)] last:border-b-0">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-4 py-2.5">
              <span className="t-subhead">{row.takenByName}</span>
              <span className="t-caption text-[var(--ink-tertiary)]">
                改了 {row.changeCount} 格 · {row.changeSummary}
              </span>
              {row.isRollback && <AdminTag>回滚</AdminTag>}
              <span className="t-caption ml-auto tabular-nums text-[var(--ink-quaternary)]">
                {new Date(row.createdAt).toLocaleString("zh-CN", {
                  timeZone: "Asia/Shanghai",
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>

              {canRollback && (
                <AdminButton
                  tone="neutral"
                  size="sm"
                  onClick={() => (openId === row.id ? setOpenId(null) : open(row.id))}
                  aria-expanded={openId === row.id}
                >
                  {openId === row.id ? "收起" : "回到这次之前"}
                </AdminButton>
              )}
            </div>

            <p className="t-caption px-4 pb-2 text-[var(--ink-tertiary)]">{row.reason}</p>

            {openId === row.id && (
              <div className="border-t border-[var(--separator)] bg-[var(--surface-sunken)] px-4 py-3">
                {pending && !diff && (
                  <p className="t-caption text-[var(--ink-tertiary)]">算着会变成什么样…</p>
                )}

                {errors.length > 0 && (
                  <ul role="alert" className="mb-2 space-y-0.5">
                    {errors.map((e) => (
                      <li key={e} className="t-subhead text-[var(--danger)]">
                        {e}
                      </li>
                    ))}
                  </ul>
                )}

                {diff && diff.changes.length === 0 && (
                  <p className="t-subhead text-[var(--ink-tertiary)]">
                    现在的矩阵和那时候一模一样，不用回滚。
                  </p>
                )}

                {diff && diff.changes.length > 0 && (
                  <>
                    {/*
                      * 「回到之前」听起来不会有事，所以这句话要说得比编辑时更重:
                      * 快照拍下之后可能已经过了三天，
                      * 期间别人做的调整会被一起抹掉。
                      */}
                    <p className="t-body mb-1 font-medium">{diff.summary}</p>
                    <p className="t-caption mb-2 text-[var(--ink-tertiary)]">
                      会改 {diff.changes.length} 格。
                      <strong>这张快照之后别人做的调整也会一起被抹掉</strong> —— 下面是全部改动。
                    </p>

                    <ul className="mb-3 max-h-40 space-y-0.5 overflow-y-auto">
                      {diff.changes.map((c) => (
                        <li key={`${c.roleId}-${c.permissionKey}`} className="t-caption">
                          <span className="text-[var(--ink-secondary)]">{c.roleName}</span>
                          <code className="mx-1.5 font-mono text-[var(--ink-tertiary)]">
                            {c.permissionKey}
                          </code>
                          <span className="text-[var(--ink-quaternary)]">{stateLabel(c.from)}</span>
                          <span className="mx-1 text-[var(--ink-quaternary)]">→</span>
                          <span
                            className={
                              c.to === "denied"
                                ? "font-medium text-[var(--danger)]"
                                : c.to === "granted"
                                  ? "text-[var(--success)]"
                                  : "text-[var(--ink-tertiary)]"
                            }
                          >
                            {stateLabel(c.to)}
                          </span>
                        </li>
                      ))}
                    </ul>

                    <label className="t-caption block text-[var(--ink-tertiary)]">
                      为什么回滚（必填，会进审计日志）
                      <textarea
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        rows={2}
                        className={`mt-1 resize-none ${adminFieldClass}`}
                      />
                    </label>

                    {/* 理由必填这件事要由按钮的禁用态表达出来 ——
                        原来点下去才会被服务端挡回来，而错误提示在半屏之外 */}
                    <AdminButton
                      tone="danger"
                      className="mt-2"
                      onClick={() => confirm(row.id)}
                      disabled={pending || !reason.trim()}
                      title={reason.trim() ? undefined : "先写一句理由"}
                    >
                      {pending ? "回滚中…" : "确认回滚"}
                    </AdminButton>
                  </>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>

      <AdminNote className="px-4 pb-3">
        快照拍的是<strong>那次改动发生之前</strong>的整张表，所以恢复不依赖中间发生过什么。
        回滚走的是和普通编辑一模一样的护栏 —— 快照里可能有一项你现在没有的权限，
        那样的回滚会被挡下来。
      </AdminNote>
    </div>
  );
}
