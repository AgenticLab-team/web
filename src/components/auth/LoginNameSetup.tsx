"use client";

import { Check, Loader2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { checkUsername, clearPhone, setPhone, setUsername } from "@/lib/auth/identity-actions";
import { MAX_USERNAME, MIN_USERNAME } from "@/lib/auth/login-name";

/**
 * 设置登录名与手机号。
 *
 * ─────────────────────────────────────────
 * 为什么需要它
 * ─────────────────────────────────────────
 *
 * 密码登录一直要求填微信 ID，而真实的微信 ID 长这样：
 * `wxid_examplemember01` —— 系统分配的，绝大多数人从来没见过。
 * 于是这条兜底通道对最需要它的人等于不存在：
 * 主路不通的时候，备用钥匙上刻着一串谁也背不下来的号。
 */
export function LoginNameSetup({
  username,
  phone,
  wxId,
}: {
  username: string | null;
  phone: string | null;
  wxId: string | null;
}) {
  return (
    <div className="space-y-3">
      <UsernameRow current={username} wxId={wxId} />
      <PhoneRow current={phone} />
    </div>
  );
}

function UsernameRow({ current, wxId }: { current: string | null; wxId: string | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState(current ?? "");
  const [check, setCheck] = useState<{ ok: boolean; message: string } | null>(null);
  const [saved, setSaved] = useState(false);

  const dirty = value.trim().toLowerCase() !== (current ?? "");

  return (
    <div className="inset-group p-4">
      <label className="t-subhead font-medium" htmlFor="login-username">
        登录名
      </label>
      <p className="t-caption mt-1 leading-relaxed text-[var(--ink-tertiary)]">
        用它配合密码登录，比微信 ID{wxId ? `（${wxId}）` : ""}好记。
        {MIN_USERNAME}–{MAX_USERNAME} 个字符，中文、字母、数字、下划线、连字符。
      </p>

      <div className="mt-2.5 flex items-center gap-2">
        <input
          id="login-username"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setCheck(null);
            setSaved(false);
          }}
          /*
           * 不在每次按键时查可用性。
           *
           * 那会把「有没有这个登录名」变成一个按键频率的接口 ——
           * 而登录名的占用来源里包含所有人的微信 ID。
           * 失焦时查一次，够用，而且刚好是人写完的那一刻。
           */
          onBlur={() => {
            const raw = value.trim();
            if (!raw || raw.toLowerCase() === (current ?? "")) return;
            startTransition(async () => {
              const r = await checkUsername(raw);
              setCheck({ ok: r.ok, message: r.ok ? "可以用" : (r.error ?? "不能用") });
            });
          }}
          maxLength={MAX_USERNAME}
          autoComplete="username"
          placeholder={current ?? "还没设"}
          className="t-body min-w-0 flex-1 rounded-[var(--radius-control)] border border-[var(--separator)] bg-[var(--canvas)] px-3 py-2 outline-none focus:border-[var(--accent)]"
        />
        <button
          type="button"
          disabled={pending || !dirty || !value.trim()}
          onClick={() =>
            startTransition(async () => {
              const r = await setUsername(value);
              if (r.ok) {
                setCheck(null);
                setSaved(true);
                router.refresh();
              } else {
                setCheck({ ok: false, message: r.error ?? "没成功" });
              }
            })
          }
          className="t-subhead inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] bg-[var(--accent)] px-4 font-medium text-[var(--accent-ink)] transition active:scale-[0.97] disabled:opacity-40"
        >
          {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2.2} aria-hidden />}
          {current ? "改成这个" : "设置"}
        </button>
      </div>

      {check && (
        <p
          className="t-caption mt-1.5 flex items-center gap-1"
          style={{ color: check.ok ? "var(--success)" : "var(--danger)" }}
        >
          {check.ok ? (
            <Check className="h-3.5 w-3.5" strokeWidth={2.4} aria-hidden />
          ) : (
            <X className="h-3.5 w-3.5" strokeWidth={2.4} aria-hidden />
          )}
          {check.message}
        </p>
      )}
      {saved && <p className="t-caption mt-1.5 text-[var(--success)]">存好了，下次可以用它登录</p>}
    </div>
  );
}

function PhoneRow({ current }: { current: string | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="inset-group p-4">
      <label className="t-subhead font-medium" htmlFor="login-phone">
        手机号
      </label>

      {/*
        * 把「没验证」说在前面。
        *
        * 大部分站上填手机号意味着「以后能用它找回账号」。
        * 这里不能 —— 没有短信通道，一个未验证的号码如果能重置密码，
        * 那就是「填上别人的号码就能接管账号」。
        * 不写清楚的话，人会按别处的经验去指望它。
        */}
      <p className="t-caption mt-1 leading-relaxed text-[var(--ink-tertiary)]">
        只当一个好记的登录名用。
        <b className="font-medium text-[var(--ink-secondary)]">
          它没有经过短信验证，所以不能用来找回账号
        </b>
        ，也不会显示给任何人、不能用它搜到你。
      </p>

      <div className="mt-2.5 flex items-center gap-2">
        <input
          id="login-phone"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          inputMode="numeric"
          maxLength={13}
          autoComplete="tel"
          placeholder={current ? maskPhone(current) : "还没填"}
          className="tabular t-body min-w-0 flex-1 rounded-[var(--radius-control)] border border-[var(--separator)] bg-[var(--canvas)] px-3 py-2 outline-none focus:border-[var(--accent)]"
        />
        <button
          type="button"
          disabled={pending || !value.trim()}
          onClick={() =>
            startTransition(async () => {
              const r = await setPhone(value);
              if (r.ok) {
                setValue("");
                setError(null);
                router.refresh();
              } else setError(r.error ?? "没成功");
            })
          }
          className="t-subhead inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] bg-[var(--accent)] px-4 font-medium text-[var(--accent-ink)] transition active:scale-[0.97] disabled:opacity-40"
        >
          {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2.2} aria-hidden />}
          {current ? "换一个" : "填上"}
        </button>
      </div>

      {current && (
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              await clearPhone();
              router.refresh();
            })
          }
          className="t-caption mt-2 text-[var(--ink-tertiary)] underline-offset-4 transition hover:text-[var(--danger)] hover:underline disabled:opacity-50"
        >
          删掉手机号
        </button>
      )}

      {error && <p className="t-caption mt-1.5 text-[var(--danger)]">{error}</p>}
    </div>
  );
}

/**
 * 自己的号码也打码。
 *
 * 这一页会在别人看得见屏幕的地方打开（地铁、工位）。
 * 想确认填的是哪个号，中间四位之外足够认出来了。
 */
function maskPhone(phone: string): string {
  return `${phone.slice(0, 3)}****${phone.slice(7)}`;
}
