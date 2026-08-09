import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Avatar } from "@/components/Avatar";
import { PageHeader } from "@/components/shell/PageHeader";
import { Empty, Pill } from "@/components/ui/primitives";
import { getCurrentUser } from "@/lib/auth/session";
import { messagesOfDay } from "@/lib/forum/convert-source";
import { visibleGroupsFor } from "@/lib/queries/visibility";
import { shiftDateKey, todayKey } from "@/lib/time";

export const metadata: Metadata = { title: "按天回看" };
export const dynamic = "force-dynamic";

/**
 * 时间机器：回看任意一天的群聊。
 *
 * 「上周三那个讨论」是最常见的回溯需求，但微信里几乎没法做到 ——
 * 只能一直往上翻，翻到一半还会跳回底部。
 */
export default async function ArchivePage({
  searchParams,
}: {
  searchParams: Promise<{ group?: string; date?: string }>;
}) {
  const { group, date } = await searchParams;
  const user = await getCurrentUser();
  const groups = visibleGroupsFor(user);

  if (groups.length === 0) {
    return (
      <>
        <PageHeader title="按天回看" />
        <div className="inset-group px-6 py-10 text-center">
          <p className="t-callout text-[var(--ink-secondary)]">群聊记录仅对社群成员开放</p>
          <Link
            href="/login"
            className="t-subhead mt-5 inline-flex rounded-[var(--radius-control)] bg-[var(--accent)] px-5 py-2.5 font-medium text-[var(--accent-ink)]"
          >
            登录
          </Link>
        </div>
      </>
    );
  }

  const convId = groups.find((g) => g.convId === group)?.convId ?? groups[0].convId;
  const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : todayKey();
  const day_ = messagesOfDay(user, convId, day);
  if (day_ === null) notFound();
  const rows = day_.rows;
  const dropped = day_.dropped;

  const groupName = groups.find((g) => g.convId === convId)?.name ?? "群聊";
  const link = (d: string, g = convId) => `/archive?group=${encodeURIComponent(g)}&date=${d}`;
  const isToday = day >= todayKey();

  return (
    <>
      <PageHeader title="按天回看" subtitle={`${groupName} · ${rows.length} 条`} />

      <div className="-mx-4 mb-3 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:-mx-6 sm:px-6">
        {groups.map((g) => (
          <span key={g.convId} className="shrink-0">
            <Pill href={link(day, g.convId)} active={g.convId === convId}>
              {g.name}
            </Pill>
          </span>
        ))}
      </div>

      {/* 日期导航常驻顶部：翻天是这个页面的主操作，不该滚到底才找得到 */}
      <div className="chrome sticky top-12 z-10 mb-4 flex items-center justify-between gap-2 rounded-[var(--radius-control)] px-2 py-2">
        <Link
          href={link(shiftDateKey(day, -1))}
          aria-label="前一天"
          className="rounded-[var(--radius-control)] p-2 transition active:scale-95 hover:bg-[var(--fill)]"
        >
          <ChevronLeft className="h-4 w-4" strokeWidth={2.2} aria-hidden />
        </Link>

        <span className="tabular t-subhead font-medium">{day}</span>

        <Link
          href={isToday ? link(day) : link(shiftDateKey(day, 1))}
          aria-label="后一天"
          aria-disabled={isToday}
          className={`rounded-[var(--radius-control)] p-2 transition ${
            isToday ? "pointer-events-none opacity-30" : "active:scale-95 hover:bg-[var(--fill)]"
          }`}
        >
          <ChevronRight className="h-4 w-4" strokeWidth={2.2} aria-hidden />
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
          归档文件在服务器上，需要时可以捞回来。
        </p>
      )}

      {rows.length === 0 ? (
        <Empty title="这天没有消息" hint="换个日期看看" />
      ) : (
        <div className="inset-group">
          {rows.map((message) => (
            <div key={message.id} className="inset-row flex gap-3 px-4 py-2.5">
              <Avatar
                wxId={message.senderWxId}
                name={message.senderName}
                src={message.avatarUrl}
                size={28}
                className="mt-0.5"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="t-caption font-medium text-[var(--ink-secondary)]">
                    {message.senderName}
                  </span>
                  <span className="tabular t-caption2 text-[var(--ink-quaternary)]">
                    {new Date(message.ts).toLocaleTimeString("zh-CN", {
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                    })}
                  </span>
                </div>
                <p className="t-subhead mt-0.5 whitespace-pre-wrap break-words leading-relaxed">
                  {message.type === "text" || message.type === "quote"
                    ? message.content
                    : `[${message.type}]`}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="t-caption mt-4 px-1 leading-relaxed text-[var(--ink-tertiary)]">
        只显示你所在的群。想把某段讨论留下来，去
        <Link href="/forum/convert" className="text-[var(--accent)]">
          {" "}整理成帖子
        </Link>
        。
      </p>
    </>
  );
}
