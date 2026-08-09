import { ArrowRight, MessageCircle } from "lucide-react";
import Link from "next/link";

import { relativeTime } from "@/components/forum/PostList";
import type { Digest } from "@/lib/queries/digest";

/**
 * 「你不在的时候」。
 *
 * 这是首页上唯一一块**为「明天还会打开」而存在**的内容。
 * 签到不构成回来的理由 —— 签到是已经来了之后做的事。
 *
 * 三条原则：
 *   1. 数字要小、要具体。「新增 137 条消息」没人会点，
 *      「2 个人回复了你」会。
 *   2. 每个数字后面都得有个能去的地方，不然它只是个装饰。
 *   3. **什么都没有的时候就不显示**，而不是显示三个 0。
 *      连续几天看到 0，人就不会再看这块了。
 */
export function DigestCard({ digest, loggedIn }: { digest: Digest; loggedIn: boolean }) {
  const items = [
    digest.repliesToMe > 0 && {
      key: "replies",
      text: `${digest.repliesToMe} 个人回复了你`,
      href: "/notifications",
      strong: true,
    },
    digest.newPosts > 0 && {
      key: "posts",
      text: `${digest.newPosts} 篇新帖`,
      href: "/forum",
      strong: false,
    },
    loggedIn &&
      digest.chatQualityYesterday > 0 && {
        key: "chat",
        text: `昨天群里有 ${digest.chatQualityYesterday} 条值得看的发言`,
        /*
         * 指到「按天回看」的**那一天**。
         *
         * 这里原来写的是 /messages —— 站里根本没有这个路由，点进去 404。
         * 这一条比「链接不好看」严重：首页上唯一一块「回来的理由」，
         * 人点开第一个数字就撞上一个不存在的页面。
         * 而且必须带上日期，落到今天的空页面等于告诉他刚才那行是假的。
         */
        href: `/archive?date=${digest.chatDateKey}`,
        strong: false,
      },
  ].filter(Boolean) as { key: string; text: string; href: string; strong: boolean }[];

  if (items.length === 0 && digest.latest.length === 0) return null;

  return (
    <div className="animate-rise inset-group overflow-hidden">
      {items.length > 0 && (
        <div className="px-4 pb-1 pt-3.5">
          <p className="t-caption2 mb-2 font-medium uppercase tracking-[0.06em] text-[var(--ink-quaternary)]">
            你不在的时候
          </p>
          <ul className="space-y-1.5">
            {items.map((item) => (
              <li key={item.key}>
                <Link
                  href={item.href}
                  className="group flex items-center gap-1.5 transition-opacity active:opacity-60"
                >
                  <span
                    className={`t-body ${item.strong ? "" : "text-[var(--ink-secondary)]"}`}
                  >
                    {item.text}
                  </span>
                  <ArrowRight
                    className="h-3.5 w-3.5 shrink-0 text-[var(--ink-quaternary)] transition-transform group-hover:translate-x-0.5"
                    strokeWidth={2}
                    aria-hidden
                  />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {digest.latest.length > 0 && (
        <ul className="mt-3 border-t border-[var(--separator)]">
          {digest.latest.map((post) => (
            <li key={post.id}>
              <Link
                href={`/forum/p/${post.id}`}
                className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-[var(--fill)]"
              >
                <MessageCircle
                  className="h-4 w-4 shrink-0 text-[var(--ink-quaternary)]"
                  strokeWidth={2}
                  aria-hidden
                />
                <span className="min-w-0 flex-1">
                  <span className="t-subhead block truncate">{post.title}</span>
                  <span className="t-caption2 block truncate text-[var(--ink-quaternary)]">
                    {post.boardName} · {post.authorName} · {relativeTime(post.createdAt)}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
