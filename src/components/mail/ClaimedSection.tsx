"use client";

import { useState, useTransition } from "react";

import { buttonClass } from "@/components/ui/primitives";
import { renew } from "@/lib/mail/claim-actions";
import type { ClaimedView } from "@/lib/mail/claim";

/**
 * 我申领来的长期地址那几行。
 *
 * ⚠️ 这里**不再自带卡片和标题**。
 *
 * 原来它是一张写着「我申领的地址」的独立卡片，而隔壁还有一张
 * 写着「我的长期地址」的（自有域名那种）—— 两个名字几乎一样、
 * 装的却是两回事，站长的原话是「ui 奇差」。
 * 现在两种都由 `LongTermSection` 收进同一张「长期地址」卡里，
 * 每行自己说清楚它是哪一种。
 *
 * ═════════════════════════════════════════
 * 这一栏唯一会让人后悔的事是**错过续期**
 * ═════════════════════════════════════════
 *
 * 所以排版整个绕着「还剩多久」转：快到期的排在最前面，
 * 剩不到 30 天的染成警示色，进了宽限期的直接把话说完 ——
 * 「X 天后放回池子，别人可以申领，之后寄给这个地址的信会进别人的箱子」。
 *
 * 那句话很长，而它必须长：短一点的说法（「已过期」）不会让人立刻
 * 意识到**别人会开始收到本该给他的邮件**，而那正是唯一要紧的后果。
 *
 * ─────────────────────────────────────────
 * 续期按钮上写着价格
 * ─────────────────────────────────────────
 *
 * 和申领那一块同一条：按一下就扣分的东西，价格必须在按下之前看得见。
 */
export function ClaimedRows({ boxes }: { boxes: ClaimedView[] }) {
  if (boxes.length === 0) return null;
  return (
    <>
      {boxes.map((b) => (
        <ClaimedRow key={b.id} box={b} />
      ))}
    </>
  );
}

function ClaimedRow({ box }: { box: ClaimedView }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const doRenew = () => {
    setError(null);
    setOk(null);
    start(async () => {
      const r = await renew({ boxId: box.id });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setOk(`续到 ${new Date(r.expiresAt).toLocaleDateString("zh-CN")}，扣了 ${r.paid} 分`);
    });
  };

  const inGrace = box.status === "grace";
  /*
   * 天数是**服务端算好传下来的**。
   *
   * 这里自己减的话，一是渲染期读时钟会被 lint 拦（规则是对的），
   * 二是更实际的问题：客户端组件里的「今天」跟着用户的机器走 ——
   * 他把系统时间调快一天，页面上就显示地址明天到期。
   */
  const days = box.daysLeft;
  /* 剩不到 30 天就该开始提醒了 —— 和宽限期一样长，因为那是他能反应的窗口 */
  const soon = days !== null && days <= 30;

  return (
    <div className="rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2">
      <div className="flex items-center gap-2">
        <code className="t-footnote min-w-0 flex-1 truncate font-mono">{box.address}</code>
        {/*
          * 每行标出它是哪一种。
          *
          * 两种长期地址合进同一张卡之后，如果不标，人只能从
          * 「有没有续期按钮」去反推 —— 而那正是原来两张同名卡片
          * 造成的困惑，换个地方又出现一次。
          */}
        <span className="t-caption2 shrink-0 rounded-[var(--radius-pill)] bg-[var(--fill-strong,var(--fill))] px-1.5 py-0.5 text-[var(--ink-secondary)]">
          申领
        </span>

        {box.unreadCount > 0 && (
          <span
            className="t-caption2 shrink-0 rounded-[var(--radius-pill)] px-1.5 py-0.5"
            style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
          >
            {box.unreadCount}
          </span>
        )}
        <button
          className={buttonClass(inGrace || soon ? "primary" : "quiet", "sm")}
          onClick={doRenew}
          disabled={pending}
        >
          {pending ? "续着…" : `续一年 · ${box.rent} 分`}
        </button>
      </div>

      <p
        className="t-caption2 mt-1"
        style={{
          color: inGrace ? "var(--danger)" : soon ? "var(--warning)" : "var(--ink-quaternary)",
        }}
      >
        {inGrace ? (
          /*
            * 这句话必须把后果说完。「已过期」不会让人意识到
            * 别人会开始收到本该给他的邮件 —— 而那是唯一要紧的事。
            */
          <>
            已过期。
            {box.graceDaysLeft === null ? "宽限期结束后" : `${box.graceDaysLeft} 天后`}
            放回池子，别人可以申领 —— 之后寄给这个地址的信会进别人的箱子
          </>
        ) : days === null ? (
          `${box.tier.toUpperCase()} 档`
        ) : (
          `${box.tier.toUpperCase()} 档 · ${days} 天后到期`
        )}
      </p>

      {error && (
        <p className="t-caption2 mt-1" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      )}
      {ok && (
        <p className="t-caption2 mt-1" style={{ color: "var(--success)" }}>
          {ok}
        </p>
      )}
    </div>
  );
}
