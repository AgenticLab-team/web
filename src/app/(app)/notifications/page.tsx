import type { Metadata } from "next";
import Link from "next/link";

import { NotificationRow } from "@/components/notifications/NotificationRow";
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

      {/* 推送开关藏在设置页第三屏，没人找得到 —— 用不了的环境这里一个字都不会出现 */}

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
          {items.map((item) => (
            <NotificationRow
              key={item.id}
              id={item.id}
              type={item.type}
              href={item.link}
              readAt={item.readAt}
              targetGone={item.targetGone}
              title={item.title}
              body={item.body}
              /* 时间在服务端算好再传 —— 这条边界上只传数据 */
              timeLabel={relativeTime(item.updatedAt)}
            />
          ))}
        </Group>
      )}
    </>
  );
}
