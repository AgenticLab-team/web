"use client";

import { Bell, BellOff, Bookmark, Link2 } from "lucide-react";
import { useOptimistic, useState, useTransition } from "react";

import { toggleBookmark, toggleSubscription } from "@/lib/forum/social";

/**
 * 帖子的次级操作：收藏、订阅、复制链接。
 *
 * 全部乐观更新。复制链接给一次「已复制」的即时反馈 ——
 * 没有反馈的话用户会怀疑自己有没有点到，然后再点一次。
 */
export function PostActions({
  postId,
  bookmarked,
  subscribed,
  canAct,
}: {
  postId: string;
  bookmarked: boolean;
  subscribed: boolean;
  canAct: boolean;
}) {
  const [, startTransition] = useTransition();
  const [copied, setCopied] = useState(false);

  const [marked, setMarked] = useOptimistic(bookmarked, (_: boolean, next: boolean) => next);
  const [subbed, setSubbed] = useOptimistic(subscribed, (_: boolean, next: boolean) => next);

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
      className={`rounded-[0.5rem] p-2 transition-all duration-150 active:scale-90 ${
        active
          ? "bg-[var(--accent-soft)] text-[var(--accent)]"
          : "text-[var(--ink-tertiary)] hover:bg-[var(--fill)] hover:text-[var(--ink-secondary)]"
      }`}
    >
      {children}
    </button>
  );
}
