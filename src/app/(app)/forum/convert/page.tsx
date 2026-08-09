import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { MessagePicker } from "@/components/forum/MessagePicker";
import { PageHeader } from "@/components/shell/PageHeader";
import { BackLink, Callout, Empty, PageNote, Pill, PillRow, SearchField } from "@/components/ui/primitives";
import { getCurrentUser } from "@/lib/auth/session";
import { messagesOfDay, searchMessagesForConvert } from "@/lib/forum/convert-source";
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
  searchParams: Promise<{ group?: string; date?: string; q?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { group, date, q } = await searchParams;
  const query = (q ?? "").trim();
  const myGroups = visibleGroupsFor(user);
  if (myGroups.length === 0) notFound();

  const convId = myGroups.find((g) => g.convId === group)?.convId ?? myGroups[0].convId;
  const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : todayKey();

  /*
   * 搜到东西就按搜索来，否则按天。
   *
   * 两条路走同一个权限收口、返回同一种结构，
   * 所以下面的挑选界面一个字都不用改 —— 它拿到的都是「一串可选的消息」。
   */
  const source = query
    ? searchMessagesForConvert(user, convId, query)
    : messagesOfDay(user, convId, day);
  if (source === null) notFound();
  const rows = source.rows;
  const dropped = source.dropped;

  const groupName = myGroups.find((g) => g.convId === convId)?.name ?? convId;

  return (
    <>
      <BackLink href="/forum">论坛</BackLink>

      <PageHeader
        title="整理成帖子"
        subtitle="把群里聊出来的东西留下来"
      />

      <PillRow>
        {myGroups.map((g) => (
          /* 切群时把搜索词带上 —— 丢掉的话人得重新打一遍，而他多半以为是自己点错了 */
          <Pill
            key={g.convId}
            href={`/forum/convert?group=${encodeURIComponent(g.convId)}${
              query ? `&q=${encodeURIComponent(query)}` : `&date=${day}`
            }`}
            active={g.convId === convId}
          >
            {g.name}
          </Pill>
        ))}
      </PillRow>

      {/*
        * 搜索框用检索页那一套（同样的外形、同样的 FTS）。
        *
        * 原来这一页只能选群 + 选日期，而人想整理的东西通常是
        * 「上个月有人讲过怎么做那个部署」—— 记得内容，不记得日期。
        * 只能一天天翻，而群聊一天几百条，翻三天就放弃了。
        */}
      <form method="get" action="/forum/convert" className="mb-3">
        <input type="hidden" name="group" value={convId} />
        <SearchField
          defaultValue={query}
          placeholder={`在「${groupName}」里搜，不用记得是哪天`}
        />
      </form>

      {query && (
        <div className="mb-3 flex flex-wrap items-baseline gap-2">
          <span className="t-subhead">
            「{query}」· {rows.length} 条
            {rows.length >= 120 && "（只显示最近 120 条）"}
          </span>
          <Link
            href={`/forum/convert?group=${encodeURIComponent(convId)}&date=${day}`}
            className="t-caption text-[var(--accent)] transition active:opacity-60"
          >
            回到按天翻
          </Link>
        </div>
      )}

      {/* 搜索态下不显示翻天的控件 —— 两套导航同时在会让人不确定自己在看什么 */}
      <div className={`mb-5 flex items-center justify-between gap-2 ${query ? "hidden" : ""}`}>
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
        <Callout tone="warning">
          <p className="t-caption leading-relaxed text-[var(--ink-secondary)]">
            这一天有 {dropped} 条正文已因存储裁剪被归档，不在下面的列表里 ——
            你看到的不是完整的一天，转出来的帖子也会是残缺的。
          </p>
        </Callout>
      )}

      {rows.length === 0 ? (
        query ? (
          <Empty title={`「${query}」在这个群里没搜到`} hint="换个说法，或者回到按天翻" />
        ) : (
          <Empty title={`${groupName} 这天没有消息`} hint="换个日期看看" />
        )
      ) : (
        <MessagePicker convId={convId} groupName={groupName} messages={rows} />
      )}

      <PageNote>
        转出来的帖子<strong className="font-medium">只有本群成员看得到</strong>。
        想让更多人看到，需要被引用的每一位原作者都同意，再由管理员确认。
      </PageNote>
    </>
  );
}
