"use client";

import { FileText, MessageSquare, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Empty } from "@/components/ui/primitives";
import { discardDraft } from "@/lib/forum/draft-actions";
import type { DraftListItem } from "@/lib/forum/drafts";

import { relativeTime } from "./PostList";

/**
 * 没写完的东西。
 *
 * ─────────────────────────────────────────
 * 删除要问一次
 * ─────────────────────────────────────────
 *
 * 这一页上的每一行都是**只存在于这里**的内容 —— 没发表过、
 * 没有别的副本、也没有回收站。误点一下就永久没了，
 * 而它可能是写了半小时的东西。
 *
 * 别处的删除（收藏、关注）都不问，因为那些丢了还能再来一次。
 */
export function DraftList({
  items,
  boardNames,
}: {
  items: DraftListItem[];
  boardNames: Record<string, string>;
}) {
  if (items.length === 0) {
    return (
      <Empty
        title="没有写到一半的东西"
        hint="在发帖或回复框里写下的内容会自动存一份，换设备也能接着写"
      />
    );
  }

  return (
    <div className="inset-group">
      <ul className="stagger">
        {items.map((item, i) => (
          <li key={`${item.target}:${item.targetId}`} style={{ "--i": i } as React.CSSProperties} className="inset-row">
            <DraftRow item={item} boardNames={boardNames} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function DraftRow({
  item,
  boardNames,
}: {
  item: DraftListItem;
  boardNames: Record<string, string>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isPost = item.target === "post";
  // 帖子草稿的 targetId 是版块 key，回复草稿的是帖子 id
  const href = isPost ? `/forum/new?board=${item.targetId}` : `/forum/p/${item.targetId}`;
  const where = isPost ? (boardNames[item.targetId] ?? "某个版块") : "一条回复";

  return (
    <div className="px-4 py-3.5">
      <Link href={href} className="flex items-start gap-2.5 transition active:opacity-60">
        {isPost ? (
          <FileText
            className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ink-quaternary)]"
            strokeWidth={2}
            aria-hidden
          />
        ) : (
          <MessageSquare
            className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ink-quaternary)]"
            strokeWidth={2}
            aria-hidden
          />
        )}
        <div className="min-w-0 flex-1">
          <p className="t-callout truncate font-medium">
            {item.title || item.excerpt || "（还没写内容）"}
          </p>
          {item.title && item.excerpt && (
            <p className="t-footnote mt-0.5 truncate text-[var(--ink-secondary)]">{item.excerpt}</p>
          )}
          <p className="t-caption mt-1 text-[var(--ink-tertiary)]">
            {where} · {relativeTime(item.updatedAt)}
          </p>
        </div>
      </Link>

      {confirming ? (
        <div className="mt-2 flex items-center gap-2">
          <span className="t-caption flex-1 text-[var(--ink-secondary)]">
            删了就没了 —— 这份内容只存在这里
          </span>
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const r = await discardDraft(item.target, item.targetId);
                if (!r.ok) setError(r.error ?? "没成功");
                else router.refresh();
              })
            }
            className="t-caption rounded-[var(--radius-control)] bg-[var(--danger)] px-3 py-1.5 font-medium text-white transition active:scale-95 disabled:opacity-50"
          >
            删掉
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="t-caption px-2 py-1.5 text-[var(--ink-tertiary)]"
          >
            算了
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="t-caption mt-1.5 inline-flex items-center gap-1 rounded-[var(--radius-control)] px-2 py-1 text-[var(--ink-tertiary)] transition hover:bg-[var(--fill)] hover:text-[var(--danger)]"
        >
          <X className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          删掉这份草稿
        </button>
      )}

      {error && <p className="t-caption mt-1.5 text-[var(--danger)]">{error}</p>}
    </div>
  );
}
