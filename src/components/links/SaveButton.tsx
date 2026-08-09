"use client";

import { Bookmark } from "lucide-react";
import { useState, useTransition } from "react";

import { toggleSaveLink } from "@/lib/links/actions";

/**
 * 收藏按钮。
 *
 * 先动图标再发请求 —— 收藏是个轻动作，等一个往返才变色会让人以为没点上，
 * 于是再点一次，于是又取消了。失败时拨回去并把原因挂在 title 上。
 */
export function SaveButton({ linkId, initial }: { linkId: string; initial: boolean }) {
  const [saved, setSaved] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      aria-pressed={saved}
      aria-label={saved ? "取消收藏" : "收藏"}
      title={error ?? (saved ? "取消收藏" : "收藏")}
      disabled={pending}
      onClick={() => {
        const next = !saved;
        setSaved(next);
        setError(null);
        startTransition(async () => {
          const result = await toggleSaveLink(linkId);
          if (!result.ok) {
            setSaved(!next);
            setError(result.error ?? "操作失败");
          } else {
            setSaved(result.saved ?? next);
          }
        });
      }}
      className="tap-target shrink-0 self-start rounded-full p-1.5 transition active:opacity-50 disabled:opacity-45"
      style={{ color: error ? "var(--danger)" : saved ? "var(--accent)" : "var(--ink-quaternary)" }}
    >
      <Bookmark
        className="h-4 w-4"
        strokeWidth={2}
        fill={saved ? "currentColor" : "none"}
        aria-hidden
      />
    </button>
  );
}
