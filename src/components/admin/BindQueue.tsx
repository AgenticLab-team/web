"use client";

import { useState, useTransition } from "react";

import { AdminActions, AdminButton, AdminTag, adminFieldClass } from "@/components/admin/ui";
import {
  acceptFriendRequestAction,
  dismissBindAction,
  manualBindAction,
} from "@/lib/auth/bind-queue-actions";
import type { ApplicantVerdict } from "@/lib/auth/bind-queue";

/**
 * 绑定审批队列的交互。
 *
 * ─────────────────────────────────────────
 * 每一行要先回答那个问题，再给按钮
 * ─────────────────────────────────────────
 *
 * 队列要回答的只有一个:**「这个人是不是真的在我们群里」**。
 * 所以活跃度那句话排在按钮前面、字号更大 ——
 * 反过来的话人会先看到「通过」再去找依据,
 * 而先看到按钮的人多半不会再去找。
 *
 * 「不在任何群里」那一档整行标红,而且**按钮直接不给** ——
 * 那种情况服务端也会拒,但让人点下去再被拒是一种糟糕的教法:
 * 它教会人「先点点看」。
 */

export interface FriendRow {
  wxId: string;
  nickname: string | null;
  avatarUrl: string | null;
  requestedAt: number | null;
  note: string | null;
  verdict: ApplicantVerdict;
  boundUserId: string | null;
}

export interface StalledRow {
  /*
   * 一行是**一个人**（按 IP 聚合），不是一个码。
   *
   * 原来一行一个码，于是队列里全是「有人点开登录页看了一眼」——
   * 生产上一天 235 条那样的记录。反复取码才说明他没放弃。
   */
  ip: string;
  codes: number;
  firstAt: number;
  lastAt: number;
  latestCodeId: string;
  latestCode: string;
  expired: boolean;
}

const KIND_STYLE: Record<ApplicantVerdict["kind"], string> = {
  member: "text-[var(--success)]",
  lurker: "text-[var(--ink-secondary)]",
  stranger: "text-[var(--danger)]",
};

function time(ms: number) {
  return new Date(ms).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function FriendRequestQueue({
  rows,
  upstreamError,
  budgetReason,
  canAccept,
}: {
  rows: FriendRow[];
  upstreamError: string | null;
  budgetReason: string;
  canAccept: boolean;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = (wxId: string) =>
    startTransition(async () => {
      const result = await acceptFriendRequestAction({ wxId, reason });
      setMessage(result.ok ? { ok: true, text: result.note } : { ok: false, text: result.error });
      if (result.ok) {
        setOpenId(null);
        setReason("");
      }
    });

  if (upstreamError) {
    /*
     * 上游挂了要说出来，不能显示成「没有待处理的申请」——
     * 那会让人以为处理完了。
     */
    return (
      <div className="inset-group px-4 py-4">
        <p role="alert" className="t-subhead text-[var(--danger)]">
          {upstreamError}
        </p>
        <p className="t-caption mt-1 text-[var(--ink-tertiary)]">
          这不代表没有待处理的申请 —— 只是现在拉不到。
        </p>
      </div>
    );
  }

  return (
    <div className="inset-group">
      <p className="t-caption border-b border-[var(--separator)] px-4 py-2 leading-relaxed text-[var(--ink-tertiary)]">
        绑定<strong>不需要</strong>通过好友申请 —— 验证码在群里发就行。
        这里留着通过的口子只为极少数要走私聊备用通道的人。
        <span className="text-[var(--ink-secondary)]"> {budgetReason}。</span>
      </p>

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

      {rows.length === 0 ? (
        <div className="px-4 py-6 text-center">
          <p className="t-callout text-[var(--ink-secondary)]">没有待处理的好友申请</p>
          <p className="t-footnote mt-1.5 text-[var(--ink-tertiary)]">
            这是常态 —— 绑定的主通道是在群里发验证码，走到这里的是极少数
          </p>
        </div>
      ) : (
        <ul>
          {rows.map((row) => (
            <li key={row.wxId} className="border-b border-[var(--separator)] last:border-b-0 px-4 py-3">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="t-body font-medium">{row.nickname ?? row.wxId}</span>
                <code className="t-caption2 font-mono text-[var(--ink-quaternary)]">{row.wxId}</code>
                {row.boundUserId && <AdminTag>已有账号</AdminTag>}
                {row.requestedAt && (
                  <span className="t-caption ml-auto tabular-nums text-[var(--ink-quaternary)]">
                    {time(row.requestedAt)}
                  </span>
                )}
              </div>

              {/* 依据在按钮前面，字号更大 —— 先看到按钮的人多半不会再去找依据 */}
              <p className={`t-subhead mt-1 font-medium ${KIND_STYLE[row.verdict.kind]}`}>
                {row.verdict.label}
              </p>
              <p className="t-caption text-[var(--ink-tertiary)]">{row.verdict.detail}</p>

              {row.note && (
                <p className="t-caption mt-1 text-[var(--ink-tertiary)]">
                  申请理由：<span className="text-[var(--ink-secondary)]">{row.note}</span>
                </p>
              )}

              {canAccept && row.verdict.kind !== "stranger" && !row.boundUserId && (
                <div className="mt-2">
                  {openId === row.wxId ? (
                    <>
                      <label className="t-caption block text-[var(--ink-tertiary)]">
                        为什么要通过他（必填）
                        <input
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          className={`mt-1 ${adminFieldClass}`}
                        />
                      </label>
                      <AdminActions className="mt-2">
                        <AdminButton
                          tone="primary"
                          onClick={() => submit(row.wxId)}
                          disabled={pending || !reason.trim()}
                          title={reason.trim() ? undefined : "先写一句理由"}
                        >
                          {pending ? "通过中…" : "确认通过"}
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
                        setOpenId(row.wxId);
                        setReason("");
                        setMessage(null);
                      }}
                    >
                      通过好友申请
                    </AdminButton>
                  )}
                </div>
              )}

              {row.verdict.kind === "stranger" && (
                /*
                 * 按钮直接不给，而不是点了再被拒 ——
                 * 让人点下去再被拒会教会他「先点点看」。
                 */
                <p className="t-caption mt-1.5 text-[var(--ink-tertiary)]">
                  不提供通过按钮。他不在我们的群里，而只有群成员能登录。
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * 取了码但没能完成的绑定。
 *
 * 手动绑定是**绕过验证码**的一条路，所以这一栏的说明比按钮更长：
 * 服务端会硬性要求那个微信号在群里，这里先把话说在前面。
 */
export function StalledBindQueue({ rows, canBind }: { rows: StalledRow[]; canBind: boolean }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [wxId, setWxId] = useState("");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const run = (fn: () => Promise<{ ok: true; note: string } | { ok: false; error: string }>) =>
    startTransition(async () => {
      const result = await fn();
      setMessage(result.ok ? { ok: true, text: result.note } : { ok: false, text: result.error });
      if (result.ok) {
        setOpenId(null);
        setWxId("");
        setReason("");
      }
    });

  return (
    <div className="inset-group">
      <p className="t-caption border-b border-[var(--separator)] px-4 py-2 leading-relaxed text-[var(--ink-tertiary)]">
        <strong>反复取码但一直没成功</strong>的人 —— 打开登录页就会取一个码，
        所以只取过一次的不算卡住（那多半只是点开看了一眼）。
        手动绑定<strong>绕过了验证码</strong>，而验证码本身就是「这个人在群里」的证明，
        所以那个微信号必须在我们同步的群里，没有例外。
      </p>

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

      {rows.length === 0 ? (
        <div className="px-4 py-6 text-center">
          <p className="t-callout text-[var(--ink-secondary)]">最近一天没人卡在登录上</p>
          <p className="t-footnote mt-1.5 text-[var(--ink-tertiary)]">
            反复取码却一直没成功的人才会出现在这里
          </p>
        </div>
      ) : (
        <ul>
          {rows.map((row) => (
            <li key={row.ip} className="border-b border-[var(--separator)] px-4 py-3 last:border-b-0">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="t-body font-medium tabular-nums">取了 {row.codes} 次码</span>
                <code className="t-caption font-mono tracking-wider text-[var(--ink-secondary)]">
                  最近 {row.latestCode}
                </code>
                <AdminTag color={row.expired ? undefined : "var(--accent)"}>
                  {row.expired ? "已过期" : "还在等"}
                </AdminTag>
                <span className="t-caption ml-auto tabular-nums text-[var(--ink-quaternary)]">
                  {time(row.firstAt)} 起 · {row.ip}
                </span>
              </div>

              {canBind && (
                <div className="mt-2">
                  {openId === row.latestCodeId ? (
                    <>
                      <label className="t-caption block text-[var(--ink-tertiary)]">
                        绑到哪个微信号
                        <input
                          value={wxId}
                          onChange={(e) => setWxId(e.target.value)}
                          placeholder="wxid_..."
                          className={`mt-1 font-mono ${adminFieldClass}`}
                        />
                      </label>
                      <label className="t-caption mt-2 block text-[var(--ink-tertiary)]">
                        为什么手动绑（必填，会进审计日志）
                        <input
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          className={`mt-1 ${adminFieldClass}`}
                        />
                      </label>
                      <AdminActions className="mt-2">
                        {/* 手动绑定绕过了验证码，而验证码就是「这个人在群里」的证明 ——
                            实心红：绑错了等于把一个陌生人放进站里 */}
                        <AdminButton
                          tone="danger"
                          onClick={() => run(() => manualBindAction({ bindCodeId: row.latestCodeId, wxId, reason }))}
                          disabled={pending || !wxId.trim() || !reason.trim()}
                          title={
                            wxId.trim() && reason.trim() ? undefined : "微信号和理由都要填"
                          }
                        >
                          {pending ? "绑定中…" : "确认手动绑定"}
                        </AdminButton>
                        <AdminButton
                          tone="neutral"
                          onClick={() => run(() => dismissBindAction({ bindCodeId: row.latestCodeId, reason }))}
                          disabled={pending}
                        >
                          作废这条
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
                        setOpenId(row.latestCodeId);
                        setWxId("");
                        setReason("");
                        setMessage(null);
                      }}
                      disabled={row.expired}
                      title={row.expired ? "过期的码不能手动放行 —— 让他重新取一次" : undefined}
                    >
                      {row.expired ? "已过期，让他重新取码" : "处理"}
                    </AdminButton>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
