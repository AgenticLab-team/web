"use client";

import { Send } from "lucide-react";
import { useState } from "react";

import { sendToGroupFromWeb } from "@/lib/api-tokens/web-send";

/**
 * 在网页上往被授权的群发一条。
 *
 * ═════════════════════════════════════════
 * 发出去之前就得看见群里会看到什么
 * ═════════════════════════════════════════
 *
 * 署名是服务端拼的，前端**不参与拼**（拼两遍就会有两份规则，
 * 迟早分叉）—— 但预览必须一模一样地显示出来。
 *
 * 因为这条消息一旦发出去就撤不回来，而它会以机器人的身份
 * 出现在一千六百人面前。「我以为只发了我打的那行」是这里
 * 唯一不能允许的意外。
 *
 * 所以正文框下面直接接着那行灰色的署名，中间不留空隙 ——
 * 让它看起来就是同一条消息的一部分，因为它就是。
 */

interface Group {
  convId: string;
  name: string;
}

export function GroupComposer({
  groups,
  maxChars,
  attributionLine,
}: {
  groups: Group[];
  /** 正文预算，**已经扣掉署名** —— 服务端算的同一个数 */
  maxChars: number;
  /** 服务端拼出来的那一行，原样显示 */
  attributionLine: string;
}) {
  const [convId, setConvId] = useState(groups[0]?.convId ?? "");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<
    { ok: boolean; message: string } | null
  >(null);
  /*
   * 二次确认。不是走过场 ——
   * 点第一下之后按钮变成「确认发到『XX 群』」，把**群名**写在按钮上，
   * 因为选错群是这一页最容易犯、也最难收场的错。
   */
  const [confirming, setConfirming] = useState(false);

  const chosen = groups.find((g) => g.convId === convId);
  // 和服务端一样按码点数 —— `.length` 会把 emoji 数成两个
  const used = [...text].length;
  const over = used > maxChars;
  const empty = text.trim().length === 0;

  async function send() {
    setBusy(true);
    setResult(null);
    try {
      const r = await sendToGroupFromWeb(convId, text);
      if (r.ok) {
        setResult({ ok: true, message: r.note });
        setText("");
      } else {
        setResult({ ok: false, message: r.error });
      }
    } catch (e) {
      setResult({ ok: false, message: `没发出去：${(e as Error).message}` });
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  if (groups.length === 0) return null;

  return (
    <div className="inset-group px-3.5 py-3">
      <p className="t-subhead font-medium">在这里发一条</p>
      <p className="t-caption mt-0.5 leading-relaxed text-[var(--ink-secondary)]">
        和 API 走同一条路 —— 同一套授权、同一套限流、同一份留痕。
      </p>

      {groups.length > 1 && (
        <>
          <label className="t-caption2 mt-3 block text-[var(--ink-quaternary)]">发到哪个群</label>
          <select
            value={convId}
            onChange={(e) => {
              setConvId(e.target.value);
              setConfirming(false);
              setResult(null);
            }}
            className="t-body mt-1 w-full rounded-[var(--radius-control)] bg-[var(--surface-sunken)] px-3 py-2 outline-none"
          >
            {groups.map((g) => (
              <option key={g.convId} value={g.convId}>
                {g.name}
              </option>
            ))}
          </select>
        </>
      )}

      <label className="t-caption2 mt-3 block text-[var(--ink-quaternary)]">正文</label>
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setConfirming(false);
        }}
        rows={4}
        placeholder={`以你的名义发到${chosen ? `「${chosen.name}」` : "群里"}`}
        className="t-body mt-1 w-full resize-y rounded-t-[var(--radius-control)] bg-[var(--surface-sunken)] px-3 py-2 outline-none"
      />
      {/*
        * 署名紧贴着正文框，没有间隙 —— 它在群里就是同一条消息的最后一行。
        * 分开放的话，它看起来像一句页面上的说明，而不是会发出去的内容。
        */}
      <p className="t-caption2 -mt-px rounded-b-[var(--radius-control)] bg-[var(--surface-sunken)] px-3 pb-2 leading-relaxed text-[var(--ink-quaternary)]">
        {attributionLine}
      </p>

      <p
        className="t-caption2 mt-1.5"
        style={{ color: over ? "var(--danger)" : "var(--ink-quaternary)" }}
      >
        {used}/{maxChars} 字
        {over && " —— 太长了，发不出去"}
        {!over && `（署名那一行不占你的字数，它是额外加的）`}
      </p>

      <button
        type="button"
        disabled={busy || empty || over}
        onClick={() => (confirming ? send() : setConfirming(true))}
        className="t-footnote mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-[var(--radius-pill)] px-4 font-medium transition active:opacity-60 disabled:opacity-45"
        style={{
          background: confirming
            ? "color-mix(in srgb, var(--danger) 14%, transparent)"
            : "color-mix(in srgb, var(--accent) 12%, transparent)",
          color: confirming ? "var(--danger)" : "var(--accent)",
        }}
      >
        <Send className="h-3.5 w-3.5" strokeWidth={2.2} aria-hidden />
        {busy
          ? "发送中…"
          : confirming
            ? `确认发到「${chosen?.name ?? "这个群"}」`
            : "发送"}
      </button>
      {confirming && !busy && (
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="t-footnote ml-1 min-h-11 px-3 text-[var(--ink-tertiary)] transition active:opacity-60"
        >
          再想想
        </button>
      )}

      {result && (
        <p
          className="t-caption mt-2 rounded-[var(--radius-control)] px-2.5 py-2 leading-relaxed"
          style={{
            background: result.ok
              ? "color-mix(in srgb, var(--success) 10%, transparent)"
              : "color-mix(in srgb, var(--danger) 10%, transparent)",
            color: result.ok ? "var(--success)" : "var(--danger)",
          }}
        >
          {result.message}
        </p>
      )}
    </div>
  );
}
