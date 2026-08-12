"use client";

import { useState, useTransition } from "react";

import { grantSendAction, revokeSendAction } from "@/lib/api-tokens/actions";
import type { GrantRow } from "@/lib/api-tokens/store";

/**
 * 授权谁能往哪个群发。
 *
 * ─────────────────────────────────────────
 * 理由必填
 * ─────────────────────────────────────────
 *
 * 这是一次把「以机器人身份说话」的能力交出去的操作，
 * 而半年后回头看的时候，「为什么给了他」是唯一要问的问题。
 */
export function GrantManager({
  grants,
  groups,
  people,
  limits,
}: {
  grants: GrantRow[];
  groups: { convId: string; name: string }[];
  /** 能被授权的人。全站注册账号一百多个，一个下拉框装得下 */
  people: { id: string; name: string }[];
  limits: { perMinute: number; perHour: number; perDay: number };
}) {
  const [convId, setConvId] = useState(groups[0]?.convId ?? "");
  const [userId, setUserId] = useState(people[0]?.id ?? "");
  const [reason, setReason] = useState("");
  const [perDay, setPerDay] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = () =>
    start(async () => {
      setError(null);
      setNote(null);
      const r = await grantSendAction({
        convId,
        userId: userId.trim(),
        reason,
        // 留空 = 跟着全局走。填了也只会取更严的那个
        perDay: perDay.trim() ? Number(perDay) : null,
      });
      if (r.ok) {
        setNote(r.note);
        setReason("");
        setPerDay("");
      } else setError(r.error);
    });

  const revoke = (g: GrantRow) =>
    start(async () => {
      setError(null);
      setNote(null);
      const r = await revokeSendAction(g.convId, g.userId);
      if (r.ok) setNote(r.note);
      else setError(r.error);
    });

  return (
    <>
      <div className="inset-group mb-3 px-3.5 py-3">
        <p className="t-subhead font-medium">给一个人某个群的发送权限</p>

        <label className="t-caption2 mt-3 block text-[var(--ink-quaternary)]">群</label>
        <select
          value={convId}
          onChange={(e) => setConvId(e.target.value)}
          className="t-body mt-1 w-full rounded-[var(--radius-control)] bg-[var(--surface-sunken)] px-3 py-2 outline-none"
        >
          {groups.map((g) => (
            <option key={g.convId} value={g.convId}>
              {g.name}
            </option>
          ))}
        </select>

        <label className="t-caption2 mt-3 block text-[var(--ink-quaternary)]">授权给谁</label>
        {/*
          * 从人名里选，不是手打账号 id。
          *
          * 原来这里是一个填 `01JABC…` 的输入框 —— 而没有人知道另一个人的
          * 内部 id 长什么样：得先开用户管理页、找到他、复制、再切回来。
          * 于是这个功能虽然做出来了，实际上很难用。
          */}
        <select
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          className="t-body mt-1 w-full rounded-[var(--radius-control)] bg-[var(--surface-sunken)] px-3 py-2 outline-none"
        >
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>

        <label className="t-caption2 mt-3 block text-[var(--ink-quaternary)]">
          为什么给他（必填 —— 半年后这是唯一要问的问题）
        </label>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="比如：他在维护打卡机器人"
          className="t-body mt-1 w-full rounded-[var(--radius-control)] bg-[var(--surface-sunken)] px-3 py-2 outline-none"
        />

        <label className="t-caption2 mt-3 block text-[var(--ink-quaternary)]">
          每天最多几条（留空 = 跟全局的 {limits.perDay} 条走；填了只会更严）
        </label>
        <input
          value={perDay}
          onChange={(e) => setPerDay(e.target.value.replace(/\D/g, ""))}
          inputMode="numeric"
          placeholder={String(limits.perDay)}
          className="t-body mt-1 w-full rounded-[var(--radius-control)] bg-[var(--surface-sunken)] px-3 py-2 outline-none"
        />

        <button
          type="button"
          disabled={pending || !userId.trim() || !reason.trim()}
          onClick={submit}
          className="t-footnote mt-3 inline-flex min-h-11 items-center rounded-[var(--radius-pill)] px-3.5 font-medium text-[var(--accent)] transition active:opacity-60 disabled:opacity-45"
          style={{ background: "color-mix(in srgb, var(--accent) 12%, transparent)" }}
        >
          {pending ? "处理中…" : "授权"}
        </button>

        {error && (
          <p className="t-caption mt-2" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        )}
        {note && <p className="t-caption mt-2 text-[var(--accent)]">{note}</p>}
      </div>

      {grants.length === 0 ? (
        <p className="t-caption px-1 text-[var(--ink-tertiary)]">还没有授权过任何人。</p>
      ) : (
        <div className="space-y-1.5">
          {grants.map((g) => (
            <div
              key={`${g.convId}:${g.userId}`}
              className="inset-group flex items-start gap-2.5 px-3.5 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <p className="t-subhead font-medium">
                  {g.userName ?? g.userId} → {g.convName ?? g.convId}
                </p>
                <p className="t-caption2 text-[var(--ink-quaternary)]">
                  {g.reason ?? "（没写理由）"}
                  {g.perDay !== null && ` · 每天 ${g.perDay} 条`}
                </p>
              </div>
              <button
                type="button"
                disabled={pending}
                onClick={() => revoke(g)}
                className="t-caption2 shrink-0 rounded-[var(--radius-pill)] px-2.5 py-1 text-[var(--ink-tertiary)] transition active:opacity-60 disabled:opacity-45"
                style={{ background: "var(--fill)" }}
              >
                收回
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
