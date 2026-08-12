import { BookOpen, CheckCircle2, MessageSquare, Pin, Sparkles } from "lucide-react";
import Link from "next/link";

import { ANONYMOUS_PALETTE, Avatar } from "@/components/Avatar";
import { Empty } from "@/components/ui/primitives";
import { isLongform, readingLabel } from "@/lib/forum/longform";
import type { PostSummary } from "@/lib/forum/queries";

const TYPE_LABEL: Record<string, string> = {
  question: "问",
  showcase: "展示",
  announcement: "公告",
  poll: "投票",
};

const VISIBILITY_HINT: Record<string, string> = {
  group: "仅本群可见",
  role: "限定身份可见",
  private: "仅自己可见",
  unlisted: "不公开索引",
};

export function PostList({ posts, showBoard = false }: { posts: PostSummary[]; showBoard?: boolean }) {
  if (posts.length === 0) {
    return <Empty title="这里还没有帖子" hint="成为第一个开话题的人" />;
  }

  return (
    <div className="inset-group">
      <ul className="stagger">
        {posts.map((post, i) => (
          <li key={post.id} style={{ "--i": i } as React.CSSProperties}>
            <Link
              href={`/forum/p/${post.id}`}
              className="inset-row flex gap-3 px-4 py-3.5 transition-colors hover:bg-[var(--fill)]"
            >
              <Avatar
                {...(post.anonymous
                  ? { paletteIndex: ANONYMOUS_PALETTE }
                  : { wxId: post.authorId })}
                name={post.authorName}
                src={post.authorAvatar}
                size={38}
                className="mt-0.5"
              />

              <div className="min-w-0 flex-1">
                <div className="flex items-start gap-1.5">
                  {post.pinned && (
                    <Pin
                      className="mt-1 h-3.5 w-3.5 shrink-0 text-[var(--accent)]"
                      strokeWidth={2.2}
                      aria-label="置顶"
                    />
                  )}
                  {TYPE_LABEL[post.type] && (
                    <span className="t-caption mt-0.5 shrink-0 rounded-[0.3125rem] bg-[var(--fill)] px-1.5 py-0.5 font-medium text-[var(--ink-secondary)]">
                      {TYPE_LABEL[post.type]}
                    </span>
                  )}
                  <h3 className="t-body min-w-0 flex-1 leading-snug">{post.title}</h3>
                  {post.solved && (
                    <CheckCircle2
                      className="mt-0.5 h-4 w-4 shrink-0 text-[var(--success)]"
                      strokeWidth={2}
                      aria-label="已解决"
                    />
                  )}
                  {post.featured && (
                    <Sparkles
                      className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warning)]"
                      strokeWidth={2}
                      aria-label="精华"
                    />
                  )}
                </div>

                {post.excerpt && (
                  <p className="t-footnote mt-1 line-clamp-2 leading-relaxed text-[var(--ink-secondary)]">
                    {post.excerpt}
                  </p>
                )}

                <div className="tabular t-caption mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[var(--ink-tertiary)]">
                  <span>{post.authorName}</span>
                  <span aria-hidden>·</span>
                  <span>{relativeTime(post.lastReplyAt ?? post.createdAt)}</span>
                  {showBoard && (
                    <>
                      <span aria-hidden>·</span>
                      <span>{post.boardName}</span>
                    </>
                  )}
                  {/*
                    * 「读完要多久」只给长文标。
                    *
                    * 每条都标的话，「1 分钟」会出现在九成的帖子上，
                    * 于是它变成噪音，长文那条也就跟着没人看见了 ——
                    * 而这个标记存在的全部意义正是**让长文看起来不一样**。
                    *
                    * 它同时是一句预告：点进去是一篇文章，不是一句话。
                    * 没有这句预告的人在地铁上点开一万三千字，会直接退出去。
                    */}
                  {isLongform(post.charCount) && (
                    <>
                      <span aria-hidden>·</span>
                      <span className="flex items-center gap-0.5 text-[var(--ink-secondary)]">
                        <BookOpen className="h-3 w-3" strokeWidth={2} aria-hidden />
                        {readingLabel(post.charCount)}
                      </span>
                    </>
                  )}
                  {VISIBILITY_HINT[post.visibility] && (
                    <>
                      <span aria-hidden>·</span>
                      {/* 受限内容要明示，作者才知道谁看得到 */}
                      <span className="text-[var(--warning)]">
                        {VISIBILITY_HINT[post.visibility]}
                      </span>
                    </>
                  )}
                </div>
              </div>

              {post.replyCount > 0 && (
                <span className="tabular t-caption mt-1 flex shrink-0 items-center gap-1 text-[var(--ink-tertiary)]">
                  <MessageSquare className="h-3.5 w-3.5" strokeWidth={1.9} aria-hidden />
                  {post.replyCount}
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 相对时间。一周以上就给具体日期，「37 天前」没人算得出是哪天 */
export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  const date = new Date(ts);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString("zh-CN", {
    year: sameYear ? undefined : "numeric",
    month: "numeric",
    day: "numeric",
  });
}
