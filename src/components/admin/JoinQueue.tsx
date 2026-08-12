"use client";

import { useState, useTransition } from "react";

import { AdminActions, AdminButton, adminFieldClass } from "@/components/admin/ui";
import { handleJoinRequest } from "@/lib/join/actions";
import type { ApplicantStanding } from "@/lib/join/rules";

/**
 * 加入申请队列。
 *
 * ─────────────────────────────────────────
 * 判断在这一侧，不在提交那一侧
 * ─────────────────────────────────────────
 *
 * 提交页对所有情况只回一句一模一样的话 ——
 * 「你已经是成员了」这种体贴的反馈会把成员名单变成可枚举的。
 *
 * 所以「这个人到底什么情况」全部在这里显示，
 * 而这一页要登录、要权限。
 */

export interface JoinRow {
  id: string;
  wxId: string;
  reason: string;
  contact: string | null;
  createdAt: number;
  status: string;
  note: string | null;
  standing: ApplicantStanding;
}

const TONE: Record<ApplicantStanding["kind"], string> = {
  already_member: "text-[var(--warning)]",
  in_group: "text-[var(--success)]",
  outsider: "text-[var(--ink-secondary)]",
};

export function JoinQueue({ rows, canHandle }: { rows: JoinRow[]; canHandle: boolean }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const run = (id: string, status: "handled" | "rejected") =>
    startTransition(async () => {
      const result = await handleJoinRequest({ id, status, note });
      setMessage(result.ok ? { ok: true, text: result.note } : { ok: false, text: result.error });
      if (result.ok) {
        setOpenId(null);
        setNote("");
      }
    });

  const pendingRows = rows.filter((r) => r.status === "pending");

  return (
    <div className="inset-group">
      {message && (
        <p
          role="status"
          className={`t-subhead border-b border-[var(--separator)] px-4 py-2 ${
            message.ok ? "text-[var(--success)]" : "text-[var(--danger)]"
          }`}
        >
          {message.text}
        </p>
      )}

      {pendingRows.length === 0 ? (
        <p className="t-subhead px-4 py-4 text-[var(--ink-tertiary)]">没有待处理的加入申请。</p>
      ) : (
        <ul>
          {pendingRows.map((row) => (
            <li key={row.id} className="border-b border-[var(--separator)] px-4 py-3 last:border-b-0">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <code className="t-body font-mono">{row.wxId}</code>
                <span className="t-caption ml-auto tabular-nums text-[var(--ink-quaternary)]">
                  {new Date(row.createdAt).toLocaleString("zh-CN", {
                    timeZone: "Asia/Shanghai",
                    month: "2-digit",
                    day: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>

              {/* 依据排在按钮前面 —— 先看到按钮的人多半不会再去找依据 */}
              <p className={`t-subhead mt-1 font-medium ${TONE[row.standing.kind]}`}>
                {row.standing.label}
              </p>
              <p className="t-caption text-[var(--ink-tertiary)]">{row.standing.detail}</p>

              <p className="t-subhead mt-2 leading-relaxed">{row.reason}</p>
              {row.contact && (
                <p className="t-caption mt-0.5 text-[var(--ink-tertiary)]">
                  联系方式：{row.contact}
                </p>
              )}

              {canHandle && (
                <div className="mt-2">
                  {openId === row.id ? (
                    <>
                      <input
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        aria-label="处理说明"
                        placeholder="处理说明（申请人看不到）"
                        className={adminFieldClass}
                      />
                      <AdminActions className="mt-2">
                        <AdminButton
                          tone="primary"
                          onClick={() => run(row.id, "handled")}
                          disabled={pending}
                        >
                          已处理（人已拉进群）
                        </AdminButton>
                        {/* 拒绝也是一个答复，不是破坏性动作 —— neutral，不染红 */}
                        <AdminButton
                          tone="neutral"
                          onClick={() => run(row.id, "rejected")}
                          disabled={pending}
                        >
                          拒绝
                        </AdminButton>
                        <AdminButton tone="quiet" onClick={() => setOpenId(null)}>
                          取消
                        </AdminButton>
                      </AdminActions>
                    </>
                  ) : (
                    <AdminButton
                      tone="neutral"
                      size="sm"
                      onClick={() => {
                        setOpenId(row.id);
                        setNote("");
                        setMessage(null);
                      }}
                    >
                      处理这份申请
                    </AdminButton>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <p className="t-caption px-4 py-2 leading-relaxed text-[var(--ink-tertiary)]">
        「已处理」和「拒绝」都只是标记，<strong>不会产生任何账号</strong> ——
        这个站的入口只有群，账号跟着群成员身份来。真正让人进来的动作发生在微信里。
      </p>
    </div>
  );
}
