"use client";

import { Bell, BellOff, Bookmark, Link2 } from "lucide-react";
import { useOptimistic, useState, useTransition } from "react";

import { moveBookmarkByPost } from "@/lib/forum/bookmark-actions";
import { UNSORTED_NAME } from "@/lib/forum/bookmark-rules";
import { toggleBookmark, toggleSubscription } from "@/lib/forum/social";

/**
 * 帖子的次级操作：收藏、订阅、复制链接。
 *
 * 全部乐观更新。复制链接给一次「已复制」的即时反馈 ——
 * 没有反馈的话用户会怀疑自己有没有点到，然后再点一次。
 *
 * ─────────────────────────────────────────
 * 归类的下拉只在**已经建过收藏夹**时出现
 * ─────────────────────────────────────────
 *
 * 一个夹子都没有的人，那个下拉里只有「未分组」一个选项 ——
 * 摆在那儿既占地方又什么也做不了。建过夹子的人才用得上它，
 * 而建夹子在 /me/bookmarks 那一页。
 */
export function PostActions({
  postId,
  bookmarked,
  subscribed,
  canAct,
  folders = [],
  folderId = null,
}: {
  postId: string;
  bookmarked: boolean;
  subscribed: boolean;
  canAct: boolean;
  folders?: { id: string; name: string }[];
  folderId?: string | null;
}) {
  const [, startTransition] = useTransition();
  const [copied, setCopied] = useState(false);

  const [marked, setMarked] = useOptimistic(bookmarked, (_: boolean, next: boolean) => next);
  const [subbed, setSubbed] = useOptimistic(subscribed, (_: boolean, next: boolean) => next);
  const [folder, setFolder] = useOptimistic(folderId, (_: string | null, next: string | null) => next);

  const copy = async () => {
    const url = `${location.origin}/forum/p/${postId}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const area = document.createElement("textarea");
      area.value = url;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="flex items-center gap-1.5">
      {canAct && (
        <>
          <ActionButton
            active={marked}
            label={marked ? "已收藏" : "收藏"}
            onClick={() =>
              startTransition(async () => {
                setMarked(!marked);
                await toggleBookmark(postId);
              })
            }
          >
            <Bookmark
              className="h-4 w-4"
              strokeWidth={1.9}
              fill={marked ? "currentColor" : "none"}
              aria-hidden
            />
          </ActionButton>

          {marked && folders.length > 0 && (
            /*
              * 原生 select，不是自己搓的浮层。
              *
              * 这一行在帖子标题旁边，底下就是正文和几十条回复 ——
              * 自绘浮层被后面的层叠上下文盖住正是「更多菜单被回复挡住」
              * 那个 bug 的形状。原生下拉永远画在最上层，
              * 而且手机上直接弹系统选择器。
              */
            <select
              value={folder ?? ""}
              aria-label="收到哪个收藏夹"
              onChange={(e) => {
                const next = e.target.value || null;
                startTransition(async () => {
                  setFolder(next);
                  await moveBookmarkByPost(postId, next);
                });
              }}
              className="t-caption max-w-[7.5rem] truncate rounded-[var(--radius-control)] bg-[var(--fill)] px-2 py-1 text-[var(--ink-secondary)] outline-none"
            >
              <option value="">{UNSORTED_NAME}</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          )}

          <ActionButton
            active={subbed}
            label={subbed ? "已关注，有新回复会通知你" : "关注这个帖子"}
            onClick={() =>
              startTransition(async () => {
                setSubbed(!subbed);
                await toggleSubscription(postId);
              })
            }
          >
            {subbed ? (
              <Bell className="h-4 w-4" strokeWidth={1.9} aria-hidden />
            ) : (
              <BellOff className="h-4 w-4" strokeWidth={1.9} aria-hidden />
            )}
          </ActionButton>
        </>
      )}

      <ActionButton active={copied} label={copied ? "已复制链接" : "复制链接"} onClick={copy}>
        <Link2 className="h-4 w-4" strokeWidth={1.9} aria-hidden />
      </ActionButton>
    </div>
  );
}

function ActionButton({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`rounded-[var(--radius-chip)] p-2 transition active:scale-90 ${
        active
          ? "bg-[var(--accent-soft)] text-[var(--accent)]"
          : "text-[var(--ink-tertiary)] hover:bg-[var(--fill)] hover:text-[var(--ink-secondary)]"
      }`}
    >
      {children}
    </button>
  );
}
