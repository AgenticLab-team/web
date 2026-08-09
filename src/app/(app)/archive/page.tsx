import { ArrowDownWideNarrow, ArrowUpWideNarrow } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ArchiveMessage } from "@/components/messages/ArchiveMessage";
import { ChatTabs } from "@/components/shell/ChatTabs";
import { PageHeader } from "@/components/shell/PageHeader";
import { Pagination } from "@/components/ui/Pagination";
import {
  Callout,
  Empty,
  EmptyAction,
  PageNote,
  Pill,
  PillRow,
} from "@/components/ui/primitives";
import { getCurrentUser } from "@/lib/auth/session";
import { featureEnabled } from "@/lib/flags/server";
import { messagesOfDay } from "@/lib/forum/convert-source";
import {
  ARCHIVE_PAGE_SIZE,
  DEFAULT_ORDER,
  flipOrder,
  messageLink,
  parseMessageId,
  resolveOrder,
} from "@/lib/messages/archive-rules";
import {
  mentionsForMessages,
  replyTargetsFor,
} from "@/lib/messages/interactions";
import { locateMessage } from "@/lib/messages/locate";
import { pageHref } from "@/lib/pagination";
import { visibleGroupsFor } from "@/lib/queries/visibility";
import { currentNamesFor } from "@/lib/queries/people";
import { todayKey } from "@/lib/time";
import { DayNav } from "@/components/ui/DayNav";

export const metadata: Metadata = { title: "按天回看" };
export const dynamic = "force-dynamic";

/**
 * 时间机器：回看任意一天的群聊。
 *
 * 「上周三那个讨论」是最常见的回溯需求，但微信里几乎没法做到 ——
 * 只能一直往上翻，翻到一半还会跳回底部。
 *
 * ─────────────────────────────────────────
 * 这一页曾经把一整天全渲染出来
 * ─────────────────────────────────────────
 *
 * 真实数据里一天最多 4553 条。于是「打开今天」是一个几兆的 HTML，
 * 而且落在**这一天最早的那几条**上 —— 想看刚才说了什么，
 * 得从早上一路滑到现在。现在是：分页 + 默认最新在前。
 *
 * ─────────────────────────────────────────
 * `?m=<消息 id>` 是这一页真正的入口
 * ─────────────────────────────────────────
 *
 * 「谁 @ 了我」原来只链到 `?group=…&date=…`：落到那一天，
 * 然后自己在几千条里找那一条 —— 那不叫定位。
 * 带上 `m` 之后，服务端按 id 算出群、日期、页码（lib/messages/locate.ts），
 * 直接把那一页渲染出来、把那一条高亮出来，URL 里的 `#msg-<id>`
 * 让浏览器原生滚到它。整条链接可以收藏、分享、刷新。
 */
export default async function ArchivePage({
  searchParams,
}: {
  searchParams: Promise<{
    group?: string;
    date?: string;
    page?: string;
    /** asc | desc —— 不写就是最新在前 */
    order?: string;
    /** 要定位的消息 id */
    m?: string;
  }>;
}) {
  const params = await searchParams;
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

  const order = resolveOrder(params.order);
  const focusId = parseMessageId(params.m);
  /*
   * 定位在最前面做：它要决定看哪个群、哪一天、第几页。
   * 拿不到（消息不存在、或者查看者不在那个群）就当没传 ——
   * 不报错也不提示，退回普通的按天回看。
   * 提示「这条消息你看不了」等于确认了它存在。
   */
  const located = focusId ? locateMessage(user, focusId, { order }) : null;

  const convId =
    located?.convId ?? groups.find((g) => g.convId === params.group)?.convId ?? groups[0].convId;
  const day =
    located?.date ??
    (params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date) ? params.date : todayKey());

  const day_ = messagesOfDay(user, convId, day, {
    order,
    // 定位算出来的页码压过 URL 上的 page —— 后者多半是上一次翻页留下的
    page: located ? located.page : params.page,
    perPage: ARCHIVE_PAGE_SIZE,
  });
  if (day_ === null) notFound();
  const { rows, dropped, total, slice } = day_;

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

  /** 翻天、切群时要带上的东西。默认排序不写进 URL —— 一个参数两种写法会让链接分裂 */
  const carry = { group: convId, date: day, order: order === DEFAULT_ORDER ? undefined : order };
  const link = (d: string, g = convId) =>
    pageHref("/archive", { ...carry, group: g, date: d }, 1);

  // 论坛关掉时不给「引用」入口 —— 点过去是 404
  const canConvert = featureEnabled("forum", user);

  return (
    <>
      <PageHeader
        title="按天回看"
        subtitle={`${groupName} · ${total.toLocaleString("zh-CN")} 条`}
      />

      <ChatTabs current="archive" />

      <PillRow>
        {groups.map((g) => (
          <Pill key={g.convId} href={link(day, g.convId)} active={g.convId === convId}>
            {g.name}
          </Pill>
        ))}
      </PillRow>

      {/*
        * 排序开关。
        *
        * 默认最新在前 —— 人来这一页多半是「刚才/昨天说了什么」，
        * 从最新往回读就是他脑子里的顺序。但要整理一段讨论时，
        * 倒着读的对话是乱的（转帖那条路一直是正序，见 convert-source），
        * 所以「按对话顺序」必须一键就在旁边，而不是藏进设置。
        */}
      <PillRow>
        <Pill href={pageHref("/archive", { ...carry, order: undefined }, 1)} active={order === "desc"}>
          <span className="flex items-center gap-1">
            <ArrowDownWideNarrow className="h-3 w-3" strokeWidth={2.2} aria-hidden />
            最新在前
          </span>
        </Pill>
        <Pill
          href={pageHref("/archive", { ...carry, order: flipOrder(DEFAULT_ORDER) }, 1)}
          active={order === "asc"}
        >
          <span className="flex items-center gap-1">
            <ArrowUpWideNarrow className="h-3 w-3" strokeWidth={2.2} aria-hidden />
            按对话顺序
          </span>
        </Pill>
      </PillRow>

      {/* 跳日期的表单要把排序一起带过去 —— 丢掉的话每跳一次日期就被打回默认排序 */}
      <DayNav
        day={day}
        href={link}
        action="/archive"
        hidden={{ group: convId, order: carry.order }}
      />

      {/* 裁剪过的一天和冷清的一天长得一模一样 —— 必须说出来 */}
      {dropped > 0 && (
        <Callout tone="warning">
          <p className="t-caption leading-relaxed text-[var(--ink-secondary)]">
            这一天有 {dropped} 条正文已因存储裁剪被归档，不在下面的列表里 ——
            归档文件在服务器上，需要时可以捞回来。
          </p>
        </Callout>
      )}

      {/*
        * 要定位的那条消息不在列表里（正文被裁剪掉了）。
        * 不说的话，人点开通知看到的是一页普通消息，
        * 会以为是定位坏了，而不是那条消息已经不在了。
        */}
      {located && !located.anchored && (
        <Callout tone="warning">
          <p className="t-caption leading-relaxed text-[var(--ink-secondary)]">
            那条消息的正文已被存储裁剪，没法单独标出来 —— 下面是它当时所在的位置。
          </p>
        </Callout>
      )}

      {rows.length === 0 ? (
        <Empty title="这天没有消息" hint="换个日期看看" />
      ) : (
        <div className="inset-group">
          {rows.map((message) => (
            <ArchiveMessage
              key={message.id}
              message={message}
              mentions={mentionsByMsg.get(message.id)}
              currentNames={currentNames}
              replyTarget={
                message.replyToId ? replyTargets.get(message.replyToId) : undefined
              }
              permalink={messageLink(message.id, { convId, date: day })}
              quoteHref={
                canConvert
                  ? messageLink(message.id, { convId, date: day }, "/forum/convert")
                  : null
              }
              focused={located?.anchored === true && message.id === focusId}
            />
          ))}
        </div>
      )}

      <Pagination
        slice={slice}
        total={total}
        noun="条消息"
        basePath="/archive"
        params={carry}
      />

      <PageNote>
        只显示你所在的群。点消息右侧的引用图标可以直接把它
        <Link href="/forum/convert" className="text-[var(--accent)]">
          {" "}整理成帖子
        </Link>
        ；点时间可以拿到这一条的固定链接。
      </PageNote>
    </>
  );
}
