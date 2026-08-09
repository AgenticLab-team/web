"use client";

import { ChevronRight, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Empty } from "@/components/ui/primitives";
import { unfollowById } from "@/lib/forum/follow-actions";
import type { FollowItem } from "@/lib/forum/follow";
import { TARGET_LABEL } from "@/lib/forum/follow-rules";

/**
 * 「我关注的」列表。
 *
 * ─────────────────────────────────────────
 * 已经没了的那些也留着，能删
 * ─────────────────────────────────────────
 *
 * 版块删了、人注销了，订阅那一行还在。
 * 悄悄滤掉的话，关注数和列表条数对不上，而没有任何地方说明为什么；
 * 摆在那儿又点不动更糟。所以显示成一行灰的，带一个取消关注。
 */
export function FollowList({ items }: { items: FollowItem[] }) {
  if (items.length === 0) {
    return (
      <Empty
        title="还没关注任何人"
        hint="在成员主页或版块页右上角点「关注」，他们发新帖时会通知你"
      />
    );
  }

  return (
    <div className="inset-group">
      <ul className="stagger">
        {items.map((item, i) => (
          <li key={item.id} style={{ "--i": i } as React.CSSProperties} className="inset-row">
            <FollowRow item={item} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function FollowRow({ item }: { item: FollowItem }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const remove = () =>
    startTransition(async () => {
      const r = await unfollowById(item.id);
      if (!r.ok) setError(r.error ?? "没成功");
      else router.refresh();
    });

  const body = (
    <>
      <span className="t-caption shrink-0 rounded-[var(--radius-pill)] bg-[var(--fill)] px-2 py-0.5 text-[var(--ink-tertiary)]">
        {TARGET_LABEL[item.target]}
      </span>
      <span
        className={`t-body min-w-0 flex-1 truncate ${item.gone ? "text-[var(--ink-tertiary)]" : ""}`}
      >
        {item.name}
      </span>
      {item.href && (
        <ChevronRight
          className="h-4 w-4 shrink-0 text-[var(--ink-quaternary)]"
          strokeWidth={2}
          aria-hidden
        />
      )}
    </>
  );

  return (
    <div className="flex items-center gap-2 px-4 py-3">
      {item.href ? (
        <Link href={item.href} className="flex min-w-0 flex-1 items-center gap-2 transition active:opacity-60">
          {body}
        </Link>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2">{body}</div>
      )}

      <button
        type="button"
        disabled={pending}
        onClick={remove}
        title={`取消关注${item.name}`}
        aria-label={`取消关注${item.name}`}
        // 图标按钮撑到 32px，这一行在手机上和链接挨得很近
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-[var(--ink-tertiary)] transition hover:bg-[var(--fill)] hover:text-[var(--danger)] active:scale-90 disabled:opacity-40"
      >
        <X className="h-4 w-4" strokeWidth={2.2} aria-hidden />
      </button>

      {error && <p className="t-caption text-[var(--danger)]">{error}</p>}
    </div>
  );
}
