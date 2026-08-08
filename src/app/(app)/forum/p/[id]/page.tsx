import { ChevronLeft, MessageSquare } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Avatar } from "@/components/Avatar";
import { AcceptButton } from "@/components/forum/AcceptButton";
import { BountyBadge } from "@/components/forum/BountyBadge";
import { PostActions } from "@/components/forum/PostActions";
import { relativeTime } from "@/components/forum/PostList";
import { ReactionBar } from "@/components/forum/ReactionBar";
import { ReplyForm } from "@/components/forum/ReplyForm";
import { Section } from "@/components/ui/primitives";
import { getCurrentUser } from "@/lib/auth/session";
import { buildViewerContext } from "@/lib/forum/context";
import { getPost, listReplies } from "@/lib/forum/queries";
import { isSubscribed } from "@/lib/forum/notify";
import { isBookmarked, reactionStates } from "@/lib/forum/social-queries";
import { isIndexable } from "@/lib/forum/visibility";
import { recordView } from "@/lib/forum/actions";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const user = await getCurrentUser();
  const viewer = buildViewerContext(user);
  const post = getPost(viewer, (await params).id);
  if (!post) return { title: "帖子" };

  const indexable = isIndexable({
    visibility: post.visibility,
    authorId: post.authorId,
    status: post.raw.status,
    fromGroupChat: post.raw.visibilityLocked,
  });

  return {
    title: post.title,
    description: post.excerpt ?? undefined,
    // 非公开内容明确禁止索引，不能只靠没有外链
    robots: indexable ? undefined : { index: false, follow: false },
  };
}

const VISIBILITY_NOTE: Record<string, string> = {
  group: "这条内容只有原群成员看得到",
  role: "这条内容限定身份可见",
  private: "这条内容仅你自己可见",
  unlisted: "这条内容不会被搜索引擎收录",
};

export default async function PostPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  const viewer = buildViewerContext(user);

  const post = getPost(viewer, id);
  // 看不见与不存在给同样的 404 —— 403 会泄露「这个帖子存在」
  if (!post) notFound();

  const replies = listReplies(viewer, id);
  await recordView(id);

  // 一次查完整页的反应状态。逐条查的话，50 楼的帖子就是 200 次查询
  const reactionMap = reactionStates(
    [{ type: "post" as const, id: post.id }, ...replies.map((r) => ({ type: "reply" as const, id: r.id }))],
    user?.id ?? null,
  );
  const bookmarked = user ? isBookmarked(user.id, post.id) : false;
  const subscribed = user ? isSubscribed(user.id, post.id) : false;
  const isAsker = user?.id === post.authorId;
  const isQuestion = post.type === "question";

  const note = VISIBILITY_NOTE[post.visibility];

  return (
    <>
      <Link
        href={`/forum/${post.boardKey}`}
        className="t-subhead -ml-1 mt-6 inline-flex items-center gap-0.5 text-[var(--accent)] transition active:opacity-60"
      >
        <ChevronLeft className="h-4 w-4" strokeWidth={2.2} aria-hidden />
        {post.boardName}
      </Link>

      <article className="animate-rise pt-6">
        <h1 className="t-title1 mb-3 leading-snug">{post.title}</h1>

        <div className="mb-5 flex items-center gap-2.5">
          <Avatar wxId={post.authorId} name={post.authorName} src={post.authorAvatar} size={32} />
          <div className="min-w-0 flex-1">
            <p className="t-subhead leading-tight">{post.authorName}</p>
            <p className="tabular t-caption text-[var(--ink-tertiary)]">
              {relativeTime(post.createdAt)}
              {post.raw.editCount > 0 && ` · 编辑过 ${post.raw.editCount} 次`}
              {post.viewCount > 0 && ` · ${post.viewCount} 次浏览`}
            </p>
          </div>
        </div>

        {isQuestion && (
          <div className="mb-4">
            <BountyBadge
              postId={post.id}
              amount={post.raw.bountyPoints}
              canAdd={Boolean(isAsker && !post.raw.solvedReplyId)}
              balance={user?.points ?? 0}
            />
          </div>
        )}

        {note && (
          <p className="t-footnote mb-4 rounded-[var(--radius-control)] bg-[var(--accent-soft)] px-3 py-2 text-[var(--accent)]">
            {note}
          </p>
        )}

        <div
          className="prose-forum"
          dangerouslySetInnerHTML={{ __html: post.contentHtml }}
        />

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <ReactionBar
            targetType="post"
            targetId={post.id}
            initial={reactionMap.get(post.id) ?? []}
            canReact={Boolean(user)}
          />
          <PostActions
            postId={post.id}
            bookmarked={bookmarked}
            subscribed={subscribed}
            canAct={Boolean(user)}
          />
        </div>
      </article>

      <Section title={replies.length ? `${replies.length} 条回复` : "回复"} className="mt-9">
        {replies.length > 0 && (
          <div className="inset-group mb-4">
            {replies.map((reply) => (
              <div
                key={reply.id}
                id={`f${reply.floor}`}
                className="inset-row scroll-mt-16 px-4 py-3.5"
              >
                <div className="mb-2 flex items-center gap-2.5">
                  <Avatar
                    wxId={reply.authorId}
                    name={reply.authorName}
                    src={reply.authorAvatar}
                    size={26}
                  />
                  <span className="t-subhead">{reply.authorName}</span>
                  {reply.accepted && (
                    <span className="t-caption rounded-[var(--radius-pill)] bg-[var(--success)]/15 px-2 py-0.5 font-medium text-[var(--success)]">
                      已采纳
                    </span>
                  )}
                  <span className="flex-1" />
                  {isQuestion && isAsker && !reply.isMine && (
                    <AcceptButton
                      postId={post.id}
                      replyId={reply.id}
                      accepted={reply.accepted}
                      hasAccepted={Boolean(post.raw.solvedReplyId)}
                    />
                  )}
                  <a
                    href={`#f${reply.floor}`}
                    className="tabular t-caption text-[var(--ink-quaternary)] transition hover:text-[var(--ink-tertiary)]"
                  >
                    #{reply.floor}
                  </a>
                </div>

                {reply.quotedExcerpt && (
                  <p className="t-caption mb-2 border-l-2 border-[var(--separator)] pl-2.5 text-[var(--ink-tertiary)]">
                    {reply.quotedExcerpt}
                  </p>
                )}

                <div
                  className="prose-forum prose-forum-compact"
                  dangerouslySetInnerHTML={{ __html: reply.contentHtml }}
                />

                <div className="mt-2 flex items-center justify-between gap-3">
                  <ReactionBar
                    targetType="reply"
                    targetId={reply.id}
                    initial={reactionMap.get(reply.id) ?? []}
                    canReact={Boolean(user)}
                    compact
                  />
                  <span className="tabular t-caption shrink-0 text-[var(--ink-quaternary)]">
                    {relativeTime(reply.createdAt)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}

        {user ? (
          <ReplyForm postId={post.id} locked={post.raw.status === "locked"} />
        ) : (
          <div className="inset-group px-6 py-7 text-center">
            <MessageSquare
              className="mx-auto mb-2 h-5 w-5 text-[var(--ink-quaternary)]"
              strokeWidth={1.8}
              aria-hidden
            />
            <p className="t-subhead text-[var(--ink-secondary)]">登录后参与讨论</p>
            <Link
              href="/login"
              className="t-subhead mt-4 inline-flex rounded-[var(--radius-control)] bg-[var(--accent)] px-5 py-2.5 font-medium text-[var(--accent-ink)]"
            >
              登录
            </Link>
          </div>
        )}
      </Section>
    </>
  );
}
