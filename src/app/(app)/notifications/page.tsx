import { AtSign, Bell, MessageSquare, Radar, Shield, Sparkles } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { relativeTime } from "@/components/forum/PostList";
import { MarkAllRead } from "@/components/forum/MarkAllRead";
import { PageHeader } from "@/components/shell/PageHeader";
import { Empty, Group, Pill, PillRow } from "@/components/ui/primitives";
import { getCurrentUser } from "@/lib/auth/session";
import { listNotifications, notificationCounts } from "@/lib/forum/notify";
import { FILTER_LABELS, parseFilter, type NotificationFilter } from "@/lib/notifications/prefs";

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
  keyword: Radar,
};

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ f?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/notifications");

  const filter = parseFilter((await searchParams).f);
  const counts = notificationCounts(user.id);
  const items = listNotifications(user.id, 50, filter);
  const unread = counts.unread;

  return (
    <>
      <PageHeader
        title="通知"
        subtitle={unread ? `${unread} 条未读` : counts.all > 0 ? "都看完了" : "决定什么事值得打断你"}
        action={
          <span className="flex items-center gap-3">
            {unread > 0 && <MarkAllRead />}
            {/* 「太吵了」和「关掉它」之间的距离要尽可能短 ——
                找不到开关的人不会去翻设置，他只会不再打开通知页 */}
            <Link
              href="/me/notifications"
              className="t-subhead text-[var(--accent)] transition active:opacity-60"
            >
              设置
            </Link>
          </span>
        }
      />

      {/* 页签上带条数：空页签要能提前看出来，而不是点进去才发现 */}
      <PillRow>
        {(Object.keys(FILTER_LABELS) as NotificationFilter[]).map((key) => (
          <Pill
            key={key}
            href={key === "all" ? "/notifications" : `/notifications?f=${key}`}
            active={key === filter}
          >
            {FILTER_LABELS[key]}
            {counts[key] > 0 && (
              <span className="tabular ml-1 opacity-55">{counts[key]}</span>
            )}
          </Pill>
        ))}
      </PillRow>

      {items.length === 0 ? (
        <Empty
          title={filter === "all" ? "还没有通知" : `「${FILTER_LABELS[filter]}」下没有通知`}
          hint={
            filter === "all"
              ? "被回复、被提到、被采纳时会出现在这里"
              : counts.all > 0
                ? "换个页签看看 —— 其它分类下还有"
                : "被回复、被提到、被采纳时会出现在这里"
          }
        />
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
