"use client";

import { Bell, FileText, MessageSquare, Radar, Shield, Sparkles, AtSign } from "lucide-react";
import Link from "next/link";
import { useOptimistic, useTransition } from "react";

import { markNotificationsRead } from "@/lib/forum/notify-actions";

import { setLiveUnread } from "./live-store";

/**
 * 一条通知。
 *
 * ─────────────────────────────────────────
 * 点开之前，点了不会已读
 * ─────────────────────────────────────────
 *
 * `markNotificationsRead(id)` 一直支持传单条 id，而**全站只有
 * 「全部已读」那个按钮调它**，而且不传 id。列表里每一条都是
 * 一个光秃秃的 `<Link>`：点进去、看完、回来，红点还在。
 *
 * ─────────────────────────────────────────
 * 整行在这里画完，不接 children
 * ─────────────────────────────────────────
 *
 * 第一版把渲染留给调用方，签名是 `children: (read) => ReactNode` ——
 * 而调用方是**服务端组件**，函数过不了 RSC 那道边界：
 * 「Functions cannot be passed directly to Client Components」，
 * 整页 500。
 *
 * 教训是这个边界上只能传数据。图标因此传字符串，
 * 在这一侧映射成组件 —— 和导航那边（shell/icons.tsx）同一个办法。
 *
 * ─────────────────────────────────────────
 * 已读要立刻看得见，不能等服务端
 * ─────────────────────────────────────────
 *
 * 点一条通知紧接着就是页面跳走。等服务端回来再更新的话，
 * 那次更新发生在一个已经不存在的页面上 —— 人回来时看到的
 * 是缓存里那份还带着红点的列表，于是以为没生效、再点一次。
 */

const ICONS: Record<string, typeof Bell> = {
  mention: AtSign,
  reply_to_post: MessageSquare,
  reply_to_reply: MessageSquare,
  subscribed_reply: Bell,
  new_post: FileText,
  reaction: Sparkles,
  featured: Sparkles,
  accepted: Sparkles,
  moderation: Shield,
  system: Bell,
  keyword: Radar,
};

export function NotificationRow({
  id,
  type,
  href,
  readAt,
  title,
  body,
  timeLabel,
  targetGone = false,
}: {
  id: string;
  type: string;
  href: string | null;
  /**
   * 它指向的东西已经没了（帖子被删、消息被清）。
   *
   * 线上 95 条通知里有 10 条是这样 —— 点一下是个 404。
   * 一条点了给 404 的通知，第二次之后人就不再点任何通知了：
   * **一个不可信的入口比没有入口更糟**。
   */
  targetGone?: boolean;
  readAt: number | null;
  title: string;
  body: string | null;
  /** 「3 分钟前」—— 在服务端算好，客户端读时钟既不纯也会两行不一致 */
  timeLabel: string;
}) {
  const [, startTransition] = useTransition();
  const [read, setRead] = useOptimistic(readAt !== null, (_: boolean, next: boolean) => next);

  const Icon = ICONS[type] ?? Bell;

  const mark = () => {
    if (read) return;
    startTransition(async () => {
      setRead(true);
      const result = await markNotificationsRead(id);
      // 角标不在这一页里，revalidate 碰不到它 —— 直接把新的数写进小仓库
      if (result.ok) setLiveUnread(result.unread);
    });
  };

  const inner = (
    <>
      <span
        className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
          read
            ? "bg-[var(--fill)] text-[var(--ink-tertiary)]"
            : "bg-[var(--accent-soft)] text-[var(--accent)]"
        }`}
      >
        <Icon className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
      </span>

      <span className="min-w-0 flex-1">
        <span
          className={`t-subhead block leading-snug ${read ? "text-[var(--ink-secondary)]" : ""}`}
        >
          {title}
        </span>
        {body && (
          <span className="t-caption mt-0.5 block truncate text-[var(--ink-tertiary)]">{body}</span>
        )}
        {targetGone && (
          /*
           * 如实说，而不是删掉这条通知 ——
           * 那件事确实发生过，抹掉等于篡改历史，
           * 而且用户会记得自己见过这条、然后找不到了。
           */
          <span className="t-caption2 mt-0.5 block text-[var(--ink-quaternary)]">
            这条内容已经被删掉了
          </span>
        )}
        <span className="tabular t-caption mt-0.5 block text-[var(--ink-quaternary)]">
          {timeLabel}
        </span>
      </span>

      {!read && (
        <span
          className="mt-2 h-2 w-2 shrink-0 rounded-full bg-[var(--accent)]"
          aria-label="未读"
        />
      )}
    </>
  );

  const className =
    "inset-row flex w-full gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--fill)]";

  /*
   * 没有链接的通知也要能点掉。
   *
   * 「系统公告」这类没有落点，而它们同样会一直亮着红点 ——
   * 一条永远消不掉的未读，最后会让人把整个通知页当成噪音。
   */
  /*
   * 没有链接的、以及**目标已经没了**的，都渲染成按钮而不是链接。
   *
   * 「系统公告」这类没有落点，而它们同样会一直亮着红点 ——
   * 一条永远消不掉的未读，最后会让人把整个通知页当成噪音。
   *
   * 目标没了的那些同理：还能点掉，但不再假装点进去有东西。
   */
  if (!href || targetGone) {
    return (
      <button type="button" onClick={mark} className={className} aria-label="标记为已读">
        {inner}
      </button>
    );
  }

  return (
    <Link href={href} onClick={mark} className={className}>
      {inner}
    </Link>
  );
}
