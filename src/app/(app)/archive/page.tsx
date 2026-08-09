import { ChevronLeft, ChevronRight, Reply } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Avatar } from "@/components/Avatar";
import { MessageText } from "@/components/messages/MessageText";
import { PageHeader } from "@/components/shell/PageHeader";
import {
  Callout,
  Empty,
  EmptyAction,
  PageNote,
  Pill,
  PillRow,
} from "@/components/ui/primitives";
import { getCurrentUser } from "@/lib/auth/session";
import { messagesOfDay } from "@/lib/forum/convert-source";
import {
  mentionsForMessages,
  replyTargetsFor,
} from "@/lib/messages/interactions";
import { visibleGroupsFor } from "@/lib/queries/visibility";
import { currentNamesFor } from "@/lib/queries/people";
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
        <Empty
          title="群聊记录仅对社群成员开放"
          action={<EmptyAction href="/login">登录</EmptyAction>}
        />
      </>
    );
  }

  const convId = groups.find((g) => g.convId === group)?.convId ?? groups[0].convId;
  const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : todayKey();
  const day_ = messagesOfDay(user, convId, day);
  if (day_ === null) notFound();
  const rows = day_.rows;
  const dropped = day_.dropped;

  /*
   * 提及与回复上下文一次取齐。提及里 resolved 的人用**当前**昵称渲染
   * （落库时存的字面昵称只是证据，昵称随时会变），
   * 所以还要按 wx_id 再查一遍当前显示名。
   */
  const mentionsByMsg = mentionsForMessages(rows.map((r) => r.id));
  const mentionWxIds = new Set<string>();
  for (const list of mentionsByMsg.values()) {
    for (const m of list) if (m.wxId) mentionWxIds.add(m.wxId);
  }
  const currentNames = currentNamesFor([...mentionWxIds]);
  const replyTargets = replyTargetsFor(
    rows.map((r) => r.replyToId).filter((id): id is string => id !== null),
  );

  const groupName = groups.find((g) => g.convId === convId)?.name ?? "群聊";
  const link = (d: string, g = convId) => `/archive?group=${encodeURIComponent(g)}&date=${d}`;
  const isToday = day >= todayKey();

  return (
    <>
      <PageHeader title="按天回看" subtitle={`${groupName} · ${rows.length} 条`} />

      <PillRow>
        {groups.map((g) => (
          <Pill key={g.convId} href={link(day, g.convId)} active={g.convId === convId}>
            {g.name}
          </Pill>
        ))}
      </PillRow>

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
        <Callout tone="warning">
          <p className="t-caption leading-relaxed text-[var(--ink-secondary)]">
            这一天有 {dropped} 条正文已因存储裁剪被归档，不在下面的列表里 ——
            归档文件在服务器上，需要时可以捞回来。
          </p>
        </Callout>
      )}

      {rows.length === 0 ? (
        <Empty title="这天没有消息" hint="换个日期看看" />
      ) : (
        <div className="inset-group">
          {rows.map((message) => {
            const replyTarget = message.replyToId
              ? replyTargets.get(message.replyToId)
              : undefined;
            return (
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
                    <Link
                      href={`/members/${encodeURIComponent(message.senderWxId)}`}
                      className="t-caption font-medium text-[var(--ink-secondary)] hover:text-[var(--accent)]"
                    >
                      {message.senderName}
                    </Link>
                    <span className="tabular t-caption2 text-[var(--ink-quaternary)]">
                      {new Date(message.ts).toLocaleTimeString("zh-CN", {
                        hour: "2-digit",
                        minute: "2-digit",
                        hour12: false,
                      })}
                    </span>
                    {/* 引用目标解析不出时也要承认这是条回复 —— 上游暂不透传引用关系 */}
                    {message.type === "quote" && !replyTarget && (
                      <span
                        className="t-caption2 flex items-center gap-0.5 text-[var(--ink-quaternary)]"
                        title="这是一条引用回复，但上游未提供被引用的消息"
                      >
                        <Reply className="h-3 w-3" strokeWidth={2} aria-hidden />
                        回复
                      </span>
                    )}
                  </div>
                  {replyTarget && (
                    <div className="mt-1 rounded-[var(--radius-control)] border-l-2 border-[var(--separator)] bg-[var(--fill)] px-2.5 py-1.5">
                      <p className="t-caption2 truncate text-[var(--ink-tertiary)]">
                        {replyTarget.senderName ?? "成员"}：
                        {replyTarget.type === "text" || replyTarget.type === "quote"
                          ? replyTarget.content
                          : `[${replyTarget.type}]`}
                      </p>
                    </div>
                  )}
                  <p className="t-subhead mt-0.5 whitespace-pre-wrap break-words leading-relaxed">
                    {message.type === "text" || message.type === "quote" ? (
                      <MessageText
                        content={message.content}
                        mentions={mentionsByMsg.get(message.id)}
                        currentNames={currentNames}
                      />
                    ) : (
                      `[${message.type}]`
                    )}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <PageNote>
        只显示你所在的群。想把某段讨论留下来，去
        <Link href="/forum/convert" className="text-[var(--accent)]">
          {" "}整理成帖子
        </Link>
        。
      </PageNote>
    </>
  );
}
