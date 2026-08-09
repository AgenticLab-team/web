import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { MessagePicker } from "@/components/forum/MessagePicker";
import { PageHeader } from "@/components/shell/PageHeader";
import { Empty, Pill } from "@/components/ui/primitives";
import { getCurrentUser } from "@/lib/auth/session";
import { messagesOfDay } from "@/lib/forum/convert-source";
import { visibleGroupsFor } from "@/lib/queries/visibility";
import { shiftDateKey, todayKey } from "@/lib/time";

export const metadata: Metadata = { title: "整理成帖子" };
export const dynamic = "force-dynamic";

/**
 * 从群聊挑消息转成帖子。
 *
 * 只列出自己所在的群、只显示自己看得见的消息 ——
 * 权限在服务端收口，前端拿不到越权数据。
 */
export default async function ConvertPage({
  searchParams,
}: {
  searchParams: Promise<{ group?: string; date?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { group, date } = await searchParams;
  const myGroups = visibleGroupsFor(user);
  if (myGroups.length === 0) notFound();

  const convId = myGroups.find((g) => g.convId === group)?.convId ?? myGroups[0].convId;
  const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : todayKey();
  const day_ = messagesOfDay(user, convId, day);
  if (day_ === null) notFound();
  const rows = day_.rows;
  const dropped = day_.dropped;

  const groupName = myGroups.find((g) => g.convId === convId)?.name ?? convId;

  return (
    <>
      <Link
        href="/forum"
        className="t-subhead -ml-1 mt-6 inline-flex items-center gap-0.5 text-[var(--accent)] transition active:opacity-60"
      >
        <ChevronLeft className="h-4 w-4" strokeWidth={2.2} aria-hidden />
        论坛
      </Link>

      <PageHeader
        title="整理成帖子"
        subtitle="把群里聊出来的东西留下来"
      />

      <div className="-mx-4 mb-3 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:-mx-6 sm:px-6">
        {myGroups.map((g) => (
          <span key={g.convId} className="shrink-0">
            <Pill href={`/forum/convert?group=${encodeURIComponent(g.convId)}&date=${day}`} active={g.convId === convId}>
              {g.name}
            </Pill>
          </span>
        ))}
      </div>

      <div className="mb-5 flex items-center justify-between gap-2">
        <Link
          href={`/forum/convert?group=${encodeURIComponent(convId)}&date=${shiftDateKey(day, -1)}`}
          className="t-footnote rounded-[var(--radius-pill)] bg-[var(--fill)] px-3 py-1.5"
        >
          前一天
        </Link>
        <span className="tabular t-subhead">{day}</span>
        <Link
          href={`/forum/convert?group=${encodeURIComponent(convId)}&date=${shiftDateKey(day, 1)}`}
          className={`t-footnote rounded-[var(--radius-pill)] px-3 py-1.5 ${
            day >= todayKey()
              ? "pointer-events-none bg-[var(--fill)] opacity-40"
              : "bg-[var(--fill)]"
          }`}
        >
          后一天
        </Link>
      </div>

      {/* 裁剪过的一天和冷清的一天长得一模一样 —— 必须说出来 */}
      {dropped > 0 && (
        <p
          className="t-caption mb-3 rounded-[var(--radius-card)] px-3.5 py-2.5 leading-relaxed hairline"
          style={{
            background: "color-mix(in srgb, var(--warning) 8%, var(--surface))",
            color: "var(--ink-secondary)",
          }}
        >
          这一天有 {dropped} 条正文已因存储裁剪被归档，不在下面的列表里 ——
          你看到的不是完整的一天，转出来的帖子也会是残缺的。
        </p>
      )}

      {rows.length === 0 ? (
        <Empty title={`${groupName} 这天没有消息`} hint="换个日期看看" />
      ) : (
        <MessagePicker convId={convId} groupName={groupName} messages={rows} />
      )}

      <p className="t-caption mt-4 px-1 leading-relaxed text-[var(--ink-tertiary)]">
        转出来的帖子<strong className="font-medium">只有本群成员看得到</strong>。
        想让更多人看到，需要被引用的每一位原作者都同意，再由管理员确认。
      </p>
    </>
  );
}
