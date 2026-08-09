"use client";

import { useTransition } from "react";

import { setLiveUnread } from "@/components/notifications/live-store";
import { markNotificationsRead } from "@/lib/forum/notify-actions";

export function MarkAllRead() {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await markNotificationsRead();
          // 角标在布局里，revalidatePath("/notifications") 碰不到它
          if (result.ok) setLiveUnread(result.unread);
        })
      }
      className="t-footnote shrink-0 rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 font-medium transition active:scale-[0.97] disabled:opacity-50"
    >
      全部已读
    </button>
  );
}
