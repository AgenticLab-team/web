import { AtSign, Bell, MessageSquare, Shield, Sparkles } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { relativeTime } from "@/components/forum/PostList";
import { MarkAllRead } from "@/components/forum/MarkAllRead";
import { PageHeader } from "@/components/shell/PageHeader";
import { Empty, Group } from "@/components/ui/primitives";
import { getCurrentUser } from "@/lib/auth/session";
import { listNotifications } from "@/lib/forum/notify";

export const metadata: Metadata = { title: "通知" };
export const dynamic = "force-dynamic";

const ICONS: Record<string, typeof Bell> = {
  mention: AtSign,
  reply_to_post: MessageSquare,
  reply_to_reply: MessageSquare,
  subscribed_reply: Bell,
  reaction: Sparkles,
  featured: Sparkles,
  accepted: Sparkles,
  moderation: Shield,
  system: Bell,
};

export default async function NotificationsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const items = listNotifications(user.id, 50);
  const unread = items.filter((i) => !i.readAt).length;

  return (
    <>
      <PageHeader
        title="通知"
        subtitle={unread ? `${unread} 条未读` : "都看完了"}
        action={unread > 0 ? <MarkAllRead /> : undefined}
      />

      {items.length === 0 ? (
        <Empty title="还没有通知" hint="被回复、被提到、被采纳时会出现在这里" />
      ) : (
        <Group>
          {items.map((item) => {
            const Icon = ICONS[item.type] ?? Bell;
            const body = (
              <>
                <span
                  className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
                    item.readAt
                      ? "bg-[var(--fill)] text-[var(--ink-tertiary)]"
                      : "bg-[var(--accent-soft)] text-[var(--accent)]"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <p className={`t-subhead leading-snug ${item.readAt ? "text-[var(--ink-secondary)]" : ""}`}>
                    {item.title}
                  </p>
                  {item.body && (
                    <p className="t-caption mt-0.5 truncate text-[var(--ink-tertiary)]">
                      {item.body}
                    </p>
                  )}
                  <p className="tabular t-caption mt-0.5 text-[var(--ink-quaternary)]">
                    {relativeTime(item.updatedAt)}
                  </p>
                </div>
                {!item.readAt && (
                  <span
                    className="mt-2 h-2 w-2 shrink-0 rounded-full bg-[var(--accent)]"
                    aria-label="未读"
                  />
                )}
              </>
            );

            return item.link ? (
              <Link
                key={item.id}
                href={item.link}
                className="inset-row flex gap-3 px-4 py-3 transition-colors hover:bg-[var(--fill)]"
              >
                {body}
              </Link>
            ) : (
              <div key={item.id} className="inset-row flex gap-3 px-4 py-3">
                {body}
              </div>
            );
          })}
        </Group>
      )}
    </>
  );
}
