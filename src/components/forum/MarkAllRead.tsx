"use client";

import { useTransition } from "react";

import { markNotificationsRead } from "@/lib/forum/notify-actions";

export function MarkAllRead() {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => startTransition(() => void markNotificationsRead())}
      className="t-footnote shrink-0 rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 font-medium transition active:scale-[0.97] disabled:opacity-50"
    >
      全部已读
    </button>
  );
}
