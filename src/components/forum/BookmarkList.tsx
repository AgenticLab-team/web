"use client";

import { FolderInput, MessageSquare, PencilLine, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Empty } from "@/components/ui/primitives";
import { moveBookmark, removeBookmark, setBookmarkNote } from "@/lib/forum/bookmark-actions";
import type { BookmarkItem } from "@/lib/forum/bookmark-queries";
import { MAX_NOTE_CHARS, UNSORTED_NAME } from "@/lib/forum/bookmark-rules";

import { relativeTime } from "./PostList";

/**
 * 收藏列表。
 *
 * ─────────────────────────────────────────
 * 归类用原生 select，不是自己搓的下拉
 * ─────────────────────────────────────────
 *
 * 这一页每一行都有一个「挪到哪个夹子」。自己搓浮层的话，
 * 一页几十行就是几十个要定位、要处理外部点击、要处理层叠的浮层 ——
 * 论坛「更多」菜单被回复挡住那个 bug 就是这么来的。
 *
 * 原生 select 在手机上弹系统选择器、桌面上是原生下拉，
 * 键盘和读屏都已经对了，而且它永远画在最上层。
 */
export function BookmarkList({
  items,
  folders,
}: {
  items: BookmarkItem[];
  folders: { id: string; name: string }[];
}) {
  if (items.length === 0) {
    return (
      <Empty
        title="这一格还是空的"
        hint="在帖子右上角点收藏，之后就能在这里归类、写备注"
      />
    );
  }

  return (
    <div className="inset-group">
      <ul className="stagger">
        {items.map((item, i) => (
          <li key={item.id} style={{ "--i": i } as React.CSSProperties} className="inset-row">
            <BookmarkRow item={item} folders={folders} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function BookmarkRow({
  item,
  folders,
}: {
  item: BookmarkItem;
  folders: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) setError(r.error ?? "没成功");
      else {
        setError(null);
        router.refresh();
      }
    });

  /*
   * 看不到的那条留一行墓碑，不显示标题也不显示作者。
   *
   * 收藏那一刻能看，不代表现在还能看 —— 把标题留在那儿
   * 等于给一条已经收回去的内容留了个副本。
   */
  if (item.gone) {
    return (
      <div className="flex items-center gap-3 px-4 py-3.5">
        <p className="t-footnote min-w-0 flex-1 text-[var(--ink-tertiary)]">{item.gone.text}</p>
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => removeBookmark(item.id))}
          className="t-caption shrink-0 rounded-[var(--radius-control)] px-2 py-1 text-[var(--ink-tertiary)] transition hover:bg-[var(--fill)] disabled:opacity-50"
        >
          移除
        </button>
      </div>
    );
  }

  return (
    <div className="px-4 py-3.5">
      <Link href={`/forum/p/${item.postId}`} className="block transition active:opacity-60">
        <p className="t-callout font-medium">{item.title}</p>
        {item.excerpt && (
          <p className="t-footnote mt-1 line-clamp-2 text-[var(--ink-secondary)]">{item.excerpt}</p>
        )}
        <div className="t-caption mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[var(--ink-tertiary)]">
          {item.boardName && <span>{item.boardName}</span>}
          {item.authorName && <span>{item.authorName}</span>}
          <span className="inline-flex items-center gap-0.5">
            <MessageSquare className="h-3 w-3" strokeWidth={2} aria-hidden />
            {item.replyCount}
          </span>
          <span>收于 {relativeTime(item.createdAt)}</span>
        </div>
      </Link>

      {/*
        * 备注显示在标题下面而不是藏进菜单。
        *
        * 写备注的人是为了以后看见它 —— 藏起来的话，
        * 这个字段就和之前一样等于不存在。
        */}
      {item.note && editing === null && (
        <p className="t-footnote mt-2 rounded-[var(--radius-control)] bg-[var(--fill)] px-2.5 py-1.5 text-[var(--ink-secondary)]">
          {item.note}
        </p>
      )}

      {editing !== null && (
        <div className="mt-2">
          <textarea
            value={editing}
            onChange={(e) => setEditing(e.target.value)}
            rows={2}
            maxLength={MAX_NOTE_CHARS}
            autoFocus
            placeholder="为什么收它？以后翻到会想知道"
            className="t-footnote w-full resize-none rounded-[var(--radius-control)] border border-[var(--separator)] bg-[var(--canvas)] px-2.5 py-2 outline-none focus:border-[var(--accent)]"
          />
          <div className="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                run(async () => {
                  const r = await setBookmarkNote(item.id, editing);
                  if (r.ok) setEditing(null);
                  return r;
                })
              }
              className="t-caption rounded-[var(--radius-control)] bg-[var(--accent)] px-3 py-1.5 font-medium text-[var(--accent-ink)] transition active:scale-95 disabled:opacity-50"
            >
              存下
            </button>
            <button
              type="button"
              onClick={() => setEditing(null)}
              className="t-caption px-2 py-1.5 text-[var(--ink-tertiary)]"
            >
              取消
            </button>
            <span className="tabular t-caption ml-auto text-[var(--ink-quaternary)]">
              {editing.length}/{MAX_NOTE_CHARS}
            </span>
          </div>
        </div>
      )}

      <div className="mt-2 flex items-center gap-1.5">
        <label className="flex min-w-0 items-center gap-1">
          <FolderInput
            className="h-3.5 w-3.5 shrink-0 text-[var(--ink-quaternary)]"
            strokeWidth={2}
            aria-hidden
          />
          <span className="sr-only">挪到收藏夹</span>
          <select
            value={item.folderId ?? ""}
            disabled={pending}
            onChange={(e) => run(() => moveBookmark(item.id, e.target.value || null))}
            className="t-caption max-w-[9rem] truncate rounded-[var(--radius-control)] bg-[var(--fill)] px-2 py-1 text-[var(--ink-secondary)] outline-none disabled:opacity-50"
          >
            <option value="">{UNSORTED_NAME}</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          onClick={() => setEditing(item.note ?? "")}
          className="t-caption inline-flex items-center gap-1 rounded-[var(--radius-control)] px-2 py-1 text-[var(--ink-tertiary)] transition hover:bg-[var(--fill)]"
        >
          <PencilLine className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          {item.note ? "改备注" : "写备注"}
        </button>

        {/*
          * 这里是「移除」，不是切换收藏。
          *
          * 在列表里用切换语义的话，误点一下就变成又收藏了一次，
          * 而那一条会跳回列表最前面（按收藏时间倒序）—— 看起来像它自己动了。
          */}
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => removeBookmark(item.id))}
          className="t-caption ml-auto inline-flex items-center gap-1 rounded-[var(--radius-control)] px-2 py-1 text-[var(--ink-tertiary)] transition hover:bg-[var(--fill)] hover:text-[var(--danger)] disabled:opacity-50"
        >
          <Trash2 className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          移除
        </button>
      </div>

      {error && <p className="t-caption mt-1.5 text-[var(--danger)]">{error}</p>}
    </div>
  );
}
