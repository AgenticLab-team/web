"use client";

import { Check, KeyRound, ShieldAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { removePassword, setPassword } from "@/lib/auth/password-actions";
import { MIN_LENGTH } from "@/lib/auth/password";

/**
 * 密码设置。
 *
 * 措辞上刻意说清楚**它是干什么用的** ——
 * 一个没有理由的「设置密码」入口，多数人会跳过；
 * 而跳过它的人正是某天换了手机之后进不来、来群里问的那个人。
 *
 * 已经有密码时要先验旧的：否则一台没锁屏的电脑就能改掉别人的密码，
 * 而改完之后原主人连自己的账号都进不去。
 */
export function PasswordSetup({ hasPassword, passkeyCount }: { hasPassword: boolean; passkeyCount: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [pending, startTransition] = useTransition();

  const mismatch = confirm.length > 0 && next !== confirm;

  function reset() {
    setOpen(false);
    setRemoving(false);
    setCurrent("");
    setNext("");
    setConfirm("");
  }

  function save() {
    startTransition(async () => {
      const result = await setPassword({ password: next, current: current || undefined });
      setMessage({ text: result.ok ? (result.note ?? "已保存") : (result.error ?? "保存失败"), ok: result.ok });
      if (result.ok) {
        reset();
        router.refresh();
      }
    });
  }

  function drop() {
    startTransition(async () => {
      const result = await removePassword({ current });
      setMessage({ text: result.ok ? (result.note ?? "已删除") : (result.error ?? "删除失败"), ok: result.ok });
      if (result.ok) {
        reset();
        router.refresh();
      }
    });
  }

  return (
    <div>
      <div className="inset-group">
        <div className="inset-row flex items-start gap-3 px-4 py-3">
          <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ink-tertiary)]" strokeWidth={2} aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="t-body">{hasPassword ? "已设置密码" : "还没有设置密码"}</p>
            <p className="t-caption mt-0.5 leading-relaxed text-[var(--ink-tertiary)]">
              {hasPassword
                ? "换了设备、或者群猫娘被风控发不出验证码时，用它登录"
                : "Passkey 换设备就用不了，而验证码要靠群猫娘发得出来 —— 两条都不通的时候，密码是唯一还能进来的方式"}
            </p>
          </div>
          {!open && (
            <button
              type="button"
              onClick={() => {
                setOpen(true);
                setMessage(null);
              }}
              className="t-subhead shrink-0 text-[var(--accent)] transition active:opacity-60"
            >
              {hasPassword ? "修改" : "设置"}
            </button>
          )}
        </div>
      </div>

      {open && (
        <form
          className="animate-rise mt-2 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (removing) drop();
            else save();
          }}
        >
          {hasPassword && (
            <input
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              placeholder="现在的密码"
              autoComplete="current-password"
              className={inputClass}
            />
          )}

          {!removing && (
            <>
              <input
                type="password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                placeholder={`新密码（至少 ${MIN_LENGTH} 位）`}
                autoComplete="new-password"
                className={inputClass}
              />
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="再输一次"
                autoComplete="new-password"
                className={inputClass}
              />
              {/* 两次不一致当场说，而不是提交之后才说 */}
              {mismatch && (
                <p className="t-caption px-1" style={{ color: "var(--warning)" }}>
                  两次输入不一样
                </p>
              )}
            </>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={
                pending ||
                (hasPassword && !current) ||
                (!removing && (next.length < MIN_LENGTH || mismatch))
              }
              className="t-subhead rounded-[var(--radius-control)] px-4 py-2 font-medium text-white transition active:opacity-70 disabled:opacity-40"
              style={{ background: removing ? "var(--danger)" : "var(--accent)" }}
            >
              {removing ? "确认删除" : hasPassword ? "更新密码" : "设置密码"}
            </button>
            <button
              type="button"
              onClick={reset}
              className="t-subhead px-2 py-2 text-[var(--ink-tertiary)] transition active:opacity-60"
            >
              取消
            </button>
            {hasPassword && !removing && (
              <button
                type="button"
                onClick={() => setRemoving(true)}
                className="t-subhead ml-auto px-2 py-2 text-[var(--ink-quaternary)] transition active:opacity-60"
              >
                删掉密码
              </button>
            )}
          </div>

          {removing && passkeyCount === 0 && (
            <p
              className="t-caption flex gap-1.5 px-1 leading-relaxed"
              style={{ color: "var(--warning)" }}
            >
              <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={2.2} aria-hidden />
              你没有 Passkey。删掉密码之后只能靠群里的验证码登录 ——
              而那条路依赖群猫娘没被风控。
            </p>
          )}

          <p className="t-caption2 px-1 leading-relaxed text-[var(--ink-quaternary)]">
            不要求大小写数字符号各一个 —— 那套规则产出的是既难记又好猜的密码。
            够长就行，一句自己记得住的话最好。
          </p>
        </form>
      )}

      {message && (
        <p
          className="t-caption mt-2 flex items-center gap-1 px-1 leading-relaxed"
          style={{ color: message.ok ? "var(--ink-tertiary)" : "var(--danger)" }}
        >
          {message.ok && <Check className="h-3.5 w-3.5 shrink-0" strokeWidth={2.4} aria-hidden />}
          {message.text}
        </p>
      )}
    </div>
  );
}

const inputClass =
  "t-body w-full rounded-[var(--radius-control)] bg-[var(--fill)] px-3.5 py-2.5 outline-none transition focus:ring-2 focus:ring-[var(--accent)]";
