"use client";

import Link from "next/link";
import { useState, useTransition } from "react";

import { buttonClass } from "@/components/ui/primitives";
import { createAlias, removeAlias } from "@/lib/mail/alias-actions";
import type { AliasView } from "@/lib/mail/alias";

/**
 * 自有域名上的长期地址：行 + 「开一个」表单。
 *
 * ⚠️ 这里**不再自带卡片和标题**（原来叫「我的长期地址」，
 * 而隔壁申领那块叫「我申领的地址」—— 两个名字几乎一样、装的却是两回事）。
 * 现在两种一起收进 `LongTermSection` 那张「长期地址」卡。
 *
 * ═════════════════════════════════════════
 * 它和上面那块一次性箱**长得不一样，是故意的**
 * ═════════════════════════════════════════
 *
 * 一次性箱那一块的主角是**验证码**：地址和码各占一行大字，
 * 因为人来那儿只做两件事（拿地址、等码）。
 *
 * 长期地址不是。它是一个「地址」——你会把它写进别人的通讯录，
 * 而不是盯着它等一封信。所以这里的主角是**地址列表**，
 * 每行带一个未读数，点进去才是信。
 *
 * 两块用同一种排版的话，页面会变成一长串同样大小的卡片，
 * 而「哪个是我在等的、哪个是我长期用的」这个区别就没了。
 */
export function AliasRows({ aliases, onRemoved }: { aliases: AliasView[]; onRemoved?: () => void }) {
  return (
    <>
      {aliases.map((a) => (
        <AliasRow key={a.id} alias={a} onRemoved={onRemoved} />
      ))}
    </>
  );
}

function AliasRow({ alias, onRemoved }: { alias: AliasView; onRemoved?: () => void }) {
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = () =>
    start(async () => {
      setError(null);
      const r = await removeAlias({ boxId: alias.id });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      onRemoved?.();
    });

  return (
    <div className="rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2">
      <div className="flex items-center gap-2">
        {/*
          * 地址 + 类型 + 未读数 + 封数整块可点 —— 补上「点进去才是信」。
          * 原来这行只显示未读/封数，没有任何入口，收的信根本读不到。
          */}
        <Link
          href={`/mail/box/${alias.id}`}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-control)] transition-colors hover:bg-[var(--fill-strong,var(--fill))]"
        >
          <code className="t-footnote min-w-0 flex-1 truncate font-mono">{alias.address}</code>
          {/*
            * 每行标出它是哪一种。
            *
            * 两种长期地址合进同一张卡之后，如果不标，人只能从
            * 「有没有续期按钮」去反推 —— 而那正是原来两张同名卡片
            * 造成的困惑，换个地方又出现一次。
            */}
          <span className="t-caption2 shrink-0 rounded-[var(--radius-pill)] bg-[var(--fill-strong,var(--fill))] px-1.5 py-0.5 text-[var(--ink-secondary)]">
            自有域名
          </span>

          {alias.unreadCount > 0 && (
            <span
              className="t-caption2 shrink-0 rounded-[var(--radius-pill)] px-1.5 py-0.5"
              style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
            >
              {alias.unreadCount}
            </span>
          )}
          <span className="tabular t-caption2 shrink-0 text-[var(--ink-tertiary)]">
            {alias.messageCount} 封
          </span>
        </Link>
        {/*
          * ⚠️ 删除按钮**用 `--ink-secondary`，不用 `--ink-quaternary`**。
          *
          * 一次性箱那个扔掉键原来是 quaternary —— 量出来对比度 1.4:1，
          * 基本等于看不见，而站长的反馈正是「还没法删除」：
          * 按钮在，只是没人找得到它。
          * 一个**动作**永远不该用全站最淡的那一档。
          */}
        <button
          className="tap-target t-caption2 shrink-0 text-[var(--ink-secondary)] underline underline-offset-2 transition-colors hover:text-[var(--danger)]"
          onClick={() => (confirming ? remove() : setConfirming(true))}
          disabled={pending}
        >
          {pending ? "关着…" : confirming ? "真的关掉" : "关掉"}
        </button>
      </div>

      {confirming && !pending && (
        /*
          * 二次确认要说**后果**，不是「确定吗」。
          * 关掉之后寄到这个地址的信直接退回，而他可能已经把它
          * 写进了别人的通讯录 —— 那是唯一值得犹豫的点。
          */
        <p className="t-caption2 mt-1 text-[var(--ink-tertiary)]">
          关掉之后寄到这个地址的信会被退回。已经收到的信还留着，同一个前缀以后还能再开
        </p>
      )}
      {error && (
        <p className="t-caption2 mt-1" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      )}
    </div>
  );
}

export function AliasCreate({
  domains,
  onDone,
}: {
  /** 我拥有的域名。空数组时调用方根本不该渲染这个 */
  domains: { domain: string }[];
  onDone?: () => void;
}) {
  const [local, setLocal] = useState("");
  const [domain, setDomain] = useState(domains[0]?.domain ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const create = () => {
    setError(null);
    start(async () => {
      const r = await createAlias({ domain, localPart: local });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setLocal("");
      onDone?.();
    });
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          className="t-body min-h-11 min-w-0 flex-1 rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2"
          placeholder="想要的前缀"
          value={local}
          onChange={(e) => setLocal(e.target.value)}
          aria-label="自有域名地址的前缀"
          autoFocus
        />
        <select
          className="t-body min-h-11 min-w-0 shrink-0 rounded-[var(--radius-control)] bg-[var(--fill)] px-2 py-2"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          aria-label="选一个你自己的域名"
        >
          {domains.map((d) => (
            <option key={d.domain} value={d.domain}>
              @{d.domain}
            </option>
          ))}
        </select>
      </div>
      {error && (
        <p className="t-caption" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      )}
      <button
        className={buttonClass("primary", "sm")}
        onClick={create}
        disabled={pending || !local.trim()}
      >
        {pending ? "开着…" : "开这个地址"}
      </button>
    </div>
  );
}
