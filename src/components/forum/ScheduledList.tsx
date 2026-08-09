"use client";

import { CalendarClock, Send } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { cancelSchedule, publishNow } from "@/lib/forum/schedule-actions";
import type { ScheduledPost } from "@/lib/forum/schedule";

/**
 * 「等着发的」。
 *
 * ─────────────────────────────────────────
 * 和草稿箱放在同一页，但要分得开
 * ─────────────────────────────────────────
 *
 * 站里现在有两种「还没发出来的东西」，而它们是两码事：
 *
 * · 草稿箱（`forum_drafts`）—— **还没写完**，连帖子行都还没有
 * · 这一节（`posts.status = draft` + `scheduled_at`）—— **写完了**，
 *   在等一个时间
 *
 * 混在一起的话，人会以为「等着发的」也需要自己再点一次发布。
 * 所以标题、图标、每一行的措辞都分开，而且这一节排在前面 ——
 * 它是有截止时间的那一类。
 */
export function ScheduledList({ items }: { items: ScheduledPost[] }) {
  if (items.length === 0) return null;

  return (
    <div className="inset-group">
      <ul className="stagger">
        {items.map((item, i) => (
          <li key={item.id} style={{ "--i": i } as React.CSSProperties} className="inset-row">
            <Row item={item} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function Row({ item }: { item: ScheduledPost }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) setError(r.error ?? "没成功");
      else router.refresh();
    });

  return (
    <div className="px-4 py-3.5">
      {/* 标题点进去能预览 —— 这一刻只有作者和版主看得到 */}
      <Link href={`/forum/p/${item.id}`} className="block transition active:opacity-60">
        <p className="t-callout font-medium">{item.title}</p>
      </Link>

      <p className="t-caption mt-1 flex flex-wrap items-center gap-x-1.5 text-[var(--ink-tertiary)]">
        <CalendarClock className="h-3.5 w-3.5 shrink-0" strokeWidth={2} aria-hidden />
        {item.boardName}
        <span aria-hidden>·</span>
        {/*
          * 已经过点但还没发出去 —— 说清楚是在等那一轮定时任务，
          * 而不是卡住了。不说的话这一行看起来就是坏的。
          */}
        {item.due ? (
          <span style={{ color: "var(--warning)" }}>已到点，正在等这一轮检查</span>
        ) : (
          <span>{item.whenLabel}发出</span>
        )}
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => publishNow(item.id))}
          className="t-caption inline-flex items-center gap-1 rounded-[var(--radius-control)] bg-[var(--accent)] px-3 py-1.5 font-medium text-[var(--accent-ink)] transition active:scale-95 disabled:opacity-50"
        >
          <Send className="h-3.5 w-3.5" strokeWidth={2.2} aria-hidden />
          现在就发
        </button>

        {/*
          * 「取消定时」不是删除 —— 它变成一篇没有时间的草稿，内容还在。
          * 删掉的话，一次「我再想想」就毁掉整篇。
          */}
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => cancelSchedule(item.id))}
          className="t-caption rounded-[var(--radius-control)] px-2.5 py-1.5 text-[var(--ink-tertiary)] transition hover:bg-[var(--fill)] disabled:opacity-50"
        >
          取消定时（内容留着）
        </button>

        <Link
          href={`/forum/p/${item.id}/edit`}
          className="inline-flex items-center t-caption rounded-[var(--radius-control)] px-2.5 py-1.5 text-[var(--ink-tertiary)] transition hover:bg-[var(--fill)]"
        >
          去改改
        </Link>
      </div>

      {error && <p className="t-caption mt-1.5 text-[var(--danger)]">{error}</p>}
    </div>
  );
}
