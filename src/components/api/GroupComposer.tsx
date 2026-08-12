"use client";

import { AlertTriangle, CheckCircle2, Send, ShieldCheck } from "lucide-react";
import { useState } from "react";

import { ActionButton, CONTROL, Field, Panel, StatusNote } from "@/components/api/fields";
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
 * 所以正文框和那行灰色的署名装在**同一个外框里**，中间只有一条
 * 发丝线 —— 它看起来就是同一条消息的两部分，因为它就是。
 * 外框在聚焦时整块亮起（不是只有 textarea 亮），
 * 让「我正在编辑的是这一整条」这件事在视觉上成立。
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
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
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

  /*
   * 字数条的颜色分三档。只给一个数字（「412/460」）的话，
   * 人要自己做一次减法才知道还剩多少 —— 而一条会跳色的进度条
   * 是不用算的。
   */
  const ratio = Math.min(1, used / Math.max(1, maxChars));
  const meterColor = over
    ? "var(--danger)"
    : ratio > 0.85
      ? "var(--warning)"
      : "var(--accent)";

  return (
    <Panel
      id="send"
      title="在这里发一条"
      hint="和 API 走同一条路：同一套授权、同一套限流、同一份留痕。"
    >
      {groups.length > 1 && (
        <Field label="发到哪个群" className="mb-4">
          <select
            value={convId}
            onChange={(e) => {
              setConvId(e.target.value);
              setConfirming(false);
              setResult(null);
            }}
            className={CONTROL}
          >
            {groups.map((g) => (
              <option key={g.convId} value={g.convId}>
                {g.name}
              </option>
            ))}
          </select>
        </Field>
      )}

      <Field label="群里会看到的" hint="灰色那一行是自动加的，去不掉，也不占你的字数。">
        {/*
          * 正文和署名装在一个外框里 —— 见文件头。
          * focus-within 让整块亮起：只亮 textarea 的话，
          * 署名那一行看起来像框外面的一句说明。
          */}
        <div className="overflow-hidden rounded-[var(--radius-control)] bg-[var(--surface-sunken)] focus-within:ring-2 focus-within:ring-[var(--accent)]">
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setConfirming(false);
            }}
            rows={4}
            placeholder={`以你的名义发到${chosen ? `「${chosen.name}」` : "群里"}`}
            className="t-body w-full resize-y bg-transparent px-3 py-2.5 outline-none placeholder:text-[var(--ink-quaternary)]"
          />
          <p className="t-caption2 hairline-t flex items-center gap-1.5 px-3 py-2 leading-relaxed text-[var(--ink-tertiary)]">
            <ShieldCheck className="h-3.5 w-3.5 shrink-0" strokeWidth={2.2} aria-hidden />
            <span className="min-w-0 flex-1">{attributionLine}</span>
          </p>
        </div>
      </Field>

      {/* 字数条：动 translateX 不动 width —— 见 globals.css 的 .progress-fill */}
      <div className="mt-2 flex items-center gap-2.5">
        <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-[var(--radius-pill)] bg-[var(--fill)]">
          <div
            className="progress-fill h-full"
            style={{
              background: meterColor,
              transform: `translateX(${ratio * 100 - 100}%)`,
            }}
            aria-hidden
          />
        </div>
        <span className="tabular t-caption2 shrink-0" style={{ color: over ? "var(--danger)" : "var(--ink-tertiary)" }}>
          {used}/{maxChars}
        </span>
      </div>
      {over && (
        <p className="t-caption mt-1" style={{ color: "var(--danger)" }}>
          太长了，发不出去。删掉 {used - maxChars} 个字。
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <ActionButton
          tone={confirming ? "danger" : "primary"}
          busy={busy}
          disabled={empty || over}
          onClick={() => (confirming ? send() : setConfirming(true))}
          icon={<Send className="h-4 w-4" strokeWidth={2.2} aria-hidden />}
        >
          {busy ? "发送中…" : confirming ? `确认发到「${chosen?.name ?? "这个群"}」` : "发送"}
        </ActionButton>
        {confirming && !busy && (
          <>
            <ActionButton tone="quiet" onClick={() => setConfirming(false)}>
              再想想
            </ActionButton>
            {/*
              * 确认那一刻再说一次「撤不回来」。
              * 说在第一下之前的话，它会变成常驻的背景噪音；
              * 说在这里，人正好停在要不要按下去的那一秒。
              */}
            <span className="t-caption w-full text-[var(--ink-tertiary)]">
              发出去就撤不回来了。
            </span>
          </>
        )}
      </div>

      {result && (
        <StatusNote
          tone={result.ok ? "ok" : "error"}
          className="mt-3"
          icon={
            result.ok ? (
              <CheckCircle2 className="h-4 w-4" strokeWidth={2.2} aria-hidden />
            ) : (
              <AlertTriangle className="h-4 w-4" strokeWidth={2.2} aria-hidden />
            )
          }
        >
          {result.message}
        </StatusNote>
      )}
    </Panel>
  );
}
