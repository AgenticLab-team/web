"use client";

import { useState, useTransition } from "react";

import { Card, buttonClass } from "@/components/ui/primitives";
import {
  confirmForwardEmail,
  setBoxForwarding,
  setForwardEmail,
} from "@/lib/mail/forward-actions";
import type { ForwardState } from "@/lib/mail/forward-queries";

const KIND_LABEL: Record<string, string> = {
  burner: "一次性",
  alias: "自有域名",
  temp: "申领的",
  reserved: "保留",
};

/**
 * 转发到私人邮箱。
 *
 * ═════════════════════════════════════════
 * 一次性箱那一栏的开关**默认关，而且要提醒一句**
 * ═════════════════════════════════════════
 *
 * 一次性箱一小时能收几十封验证码 —— 全转到私人邮箱是灾难，
 * 而人拨那个开关的时候多半没想到这件事（他想的是「都转过来吧」）。
 *
 * 所以这一栏按种类分组显示，一次性那组顶上直接写出来。
 * 不禁止 —— 有人确实想那么用；只是**让他在拨之前看见**。
 *
 * ─────────────────────────────────────────
 * 没验证邮箱之前，开关整个不出现
 * ─────────────────────────────────────────
 *
 * 出现一排拨不动的开关，比不出现糟：人会拨、会以为坏了、会来问。
 * 先把「填地址 + 验证」那两步做完，开关才有意义。
 */
export function ForwardSection({ state }: { state: ForwardState }) {
  const [email, setEmail] = useState(state.email ?? "");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (!state.available) return null;

  const send = () =>
    start(async () => {
      setError(null);
      const r = await setForwardEmail({ email });
      if (r.ok) setSent(true);
      else setError(r.error);
    });

  const confirm = () =>
    start(async () => {
      setError(null);
      const r = await confirmForwardEmail({ code });
      if (!r.ok) setError(r.error);
      else setSent(false);
    });

  return (
    <Card>
      <h2 className="t-headline">转发到私人邮箱</h2>

      {!state.verified ? (
        <>
          <p className="t-caption mt-1 text-[var(--ink-tertiary)]">
            填一个你自己的邮箱并验证 —— 没验证过的地址不转，
            一个笔误就把私信寄给陌生人了
          </p>
          <div className="mt-2 flex gap-2">
            <input
              className="t-body min-w-0 flex-1 rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              inputMode="email"
            />
            <button
              className={buttonClass("primary")}
              onClick={send}
              disabled={pending || !email.trim()}
            >
              {pending ? "发着…" : sent ? "重发" : "发验证码"}
            </button>
          </div>

          {sent && (
            <div className="mt-2 flex gap-2">
              <input
                className="tabular t-body min-w-0 flex-1 rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 font-mono"
                placeholder="六位验证码"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoFocus
              />
              <button
                className={buttonClass("primary")}
                onClick={confirm}
                disabled={pending || !code.trim()}
              >
                验证
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <p className="t-caption mt-1 text-[var(--ink-tertiary)]">
            转到 <span className="font-mono">{state.email}</span> ·
            一小时最多 50 封，超出的会被丢掉
          </p>

          {state.boxes.length === 0 ? (
            <p className="t-caption mt-3 text-[var(--ink-tertiary)]">还没有任何地址</p>
          ) : (
            <div className="mt-3 space-y-1.5">
              {state.boxes.map((b) => (
                <BoxToggle key={b.id} box={b} />
              ))}
            </div>
          )}

          {state.boxes.some((b) => b.kind === "burner") && (
            /*
              * 这一句放在列表**下面**而不是上面：上面的话它会挡在
              * 人和开关之间，而绝大多数人开的是长期地址那几个。
              * 放下面，等他真的去拨一次性箱那一行时刚好在视线里。
              */
            <p className="t-caption2 mt-2 text-[var(--ink-quaternary)]">
              一次性箱一小时能收几十封验证码 —— 全转过去的话，
              你的私人邮箱会被验证码淹掉
            </p>
          )}
        </>
      )}

      {error && (
        <p className="t-caption mt-2" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      )}
    </Card>
  );
}

function BoxToggle({ box }: { box: ForwardState["boxes"][number] }) {
  const [on, setOn] = useState(box.forwardEnabled);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const toggle = () => {
    const next = !on;
    /*
     * 先改界面再发请求（乐观更新），失败了再拨回来。
     *
     * 开关这种东西等一个来回是很难受的 —— 而失败在这里是罕见情况
     * （只有「不是你的」和网络错），拨回来的代价小于每次都等。
     */
    setOn(next);
    setError(null);
    start(async () => {
      const r = await setBoxForwarding({ boxId: box.id, on: next });
      if (!r.ok) {
        setOn(!next);
        setError(r.error);
      }
    });
  };

  return (
    /* `min-h-11` = 44px：整条 label 都能点，但它原来只有 34 高 */
    <label className="flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2">
      <input type="checkbox" checked={on} onChange={toggle} disabled={pending} />
      <code className="t-footnote min-w-0 flex-1 truncate font-mono">{box.address}</code>
      <span className="t-caption2 shrink-0 text-[var(--ink-quaternary)]">
        {KIND_LABEL[box.kind] ?? box.kind}
      </span>
      {error && (
        <span className="t-caption2 shrink-0" style={{ color: "var(--danger)" }}>
          {error}
        </span>
      )}
    </label>
  );
}
