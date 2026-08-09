"use client";

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
 * 结果是这一页只有两种状态 —— 全是红点，或者一键全灭。
 * 中间那个「我看过这条了」根本没有。
 *
 * ─────────────────────────────────────────
 * 已读要立刻看得见，不能等服务端
 * ─────────────────────────────────────────
 *
 * 点一条通知紧接着就是页面跳走。等服务端回来再更新的话，
 * 那次更新发生在一个已经不存在的页面上 —— 人回来时看到的
 * 是缓存里那份还带着红点的列表，于是以为没生效、再点一次。
 *
 * 所以乐观更新：点下去当场变灰，写库在后台跑。
 */
export function NotificationRow({
  id,
  href,
  readAt,
  children,
}: {
  id: string;
  href: string | null;
  readAt: number | null;
  children: (read: boolean) => React.ReactNode;
}) {
  const [, startTransition] = useTransition();
  const [read, setRead] = useOptimistic(readAt !== null, (_: boolean, next: boolean) => next);

  const mark = () => {
    if (read) return;
    startTransition(async () => {
      setRead(true);
      const result = await markNotificationsRead(id);
      // 角标不在这一页里，revalidate 碰不到它 —— 直接把新的数写进小仓库
      if (result.ok) setLiveUnread(result.unread);
    });
  };

  const className = "inset-row flex w-full gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--fill)]";

  /*
   * 没有链接的通知也要能点掉。
   *
   * 「系统公告」这类没有落点，而它们同样会一直亮着红点 ——
   * 一条永远消不掉的未读，最后会让人把整个通知页当成噪音。
   */
  if (!href) {
    return (
      <button type="button" onClick={mark} className={className} aria-label="标记为已读">
        {children(read)}
      </button>
    );
  }

  return (
    <Link href={href} onClick={mark} className={className}>
      {children(read)}
    </Link>
  );
}
