"use client";

import { Check } from "lucide-react";
import { useState, useTransition } from "react";

import { MAX_REASON_CHARS, MIN_REASON_CHARS } from "@/lib/join/rules";
import { submitJoinRequest } from "@/lib/join/actions";

/**
 * 加入申请表单。
 *
 * ─────────────────────────────────────────
 * 提交成功之后不给「再提交一次」的路
 * ─────────────────────────────────────────
 *
 * 成功之后整个表单换成一段确认文字。留着表单的话，
 * 人会因为「不确定有没有成功」而再点几次 ——
 * 而每一次都会在管理员那边多出一行，
 * 让真正需要处理的那些淹在重复里。
 */
export function JoinForm() {
  const [wxId, setWxId] = useState("");
  const [reason, setReason] = useState("");
  const [contact, setContact] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (done) {
    return (
      <div className="rounded-[var(--radius-card)] bg-[var(--surface)] p-5 hairline">
        <p className="t-body flex items-start gap-2 leading-relaxed">
          <Check
            className="mt-1 h-4 w-4 shrink-0 text-[var(--success)]"
            strokeWidth={2.4}
            aria-hidden
          />
          <span>{done}</span>
        </p>
      </div>
    );
  }

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const result = await submitJoinRequest({ wxId, reason, contact });
      if (result.ok) setDone(result.message);
      else setError(result.error);
    });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="space-y-4"
    >
      <label className="block">
        <span className="t-subhead">你的微信号</span>
        <span className="t-caption ml-1.5 text-[var(--ink-tertiary)]">管理员靠它在群里找你</span>
        <input
          value={wxId}
          onChange={(e) => setWxId(e.target.value)}
          autoComplete="off"
          className="t-body mt-1.5 w-full rounded-[var(--radius-control)] bg-[var(--surface)] px-4 py-3 outline-none hairline focus-visible:border-[var(--accent)]"
        />
      </label>

      <label className="block">
        <span className="t-subhead">想做什么、从哪知道这里的</span>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={4}
          maxLength={MAX_REASON_CHARS}
          className="t-body mt-1.5 w-full rounded-[var(--radius-control)] bg-[var(--surface)] px-4 py-3 leading-relaxed outline-none hairline focus-visible:border-[var(--accent)]"
        />
        {/*
          * 当场告诉人还差多少字。
          *
          * 不说的话人写一句就点提交，被打回来再补 ——
          * 而被打回一次之后放弃的比例比想象中高。
          */}
        <span
          className={`t-caption2 mt-1 block ${
            reason.trim().length >= MIN_REASON_CHARS
              ? "text-[var(--ink-quaternary)]"
              : "text-[var(--ink-tertiary)]"
          }`}
        >
          {reason.trim().length >= MIN_REASON_CHARS
            ? `${reason.trim().length} / ${MAX_REASON_CHARS}`
            : `还差 ${MIN_REASON_CHARS - reason.trim().length} 个字`}
        </span>
      </label>

      <label className="block">
        <span className="t-subhead">别的联系方式</span>
        <span className="t-caption ml-1.5 text-[var(--ink-tertiary)]">可选</span>
        <input
          value={contact}
          onChange={(e) => setContact(e.target.value)}
          autoComplete="off"
          placeholder="邮箱、GitHub、随便什么"
          className="t-body mt-1.5 w-full rounded-[var(--radius-control)] bg-[var(--surface)] px-4 py-3 outline-none hairline placeholder:text-[var(--ink-quaternary)] focus-visible:border-[var(--accent)]"
        />
      </label>

      {error && (
        <p role="alert" className="t-subhead leading-relaxed text-[var(--danger)]">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="t-body w-full rounded-[var(--radius-control)] bg-[var(--accent)] px-5 py-3 font-medium text-[var(--accent-ink)] transition active:scale-[0.99] disabled:opacity-50"
      >
        {pending ? "提交中…" : "提交申请"}
      </button>
    </form>
  );
}
