import { Lock, Pin, Star, Trash2 } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Avatar } from "@/components/Avatar";
import { AcceptButton } from "@/components/forum/AcceptButton";
import { BountyBadge } from "@/components/forum/BountyBadge";
import { ConsentPanel } from "@/components/forum/ConsentPanel";
import { PollWidget } from "@/components/forum/PollWidget";
import { TipButton } from "@/components/forum/TipButton";
import { PostActions } from "@/components/forum/PostActions";
import { PostManageMenu } from "@/components/forum/PostManageMenu";
import { ShareSheet } from "@/components/share/ShareSheet";
import { env } from "@/lib/env";
import { canSharePost, shareText } from "@/lib/share/rules";
import { relativeTime } from "@/components/forum/PostList";
import { QuoteButton } from "@/components/forum/QuoteButton";
import { QuoteProvider } from "@/components/forum/QuoteContext";
import { ReactionBar } from "@/components/forum/ReactionBar";
import { ReportButton } from "@/components/forum/ReportButton";
import { ReplyForm } from "@/components/forum/ReplyForm";
import { ReplyRow } from "@/components/forum/ReplyRow";
import { ResumeReading } from "@/components/forum/ResumeReading";
import { BackLink, Empty, EmptyAction, Pill, Section } from "@/components/ui/primitives";
import { getCurrentUser } from "@/lib/auth/session";
import { buildViewerContext } from "@/lib/forum/context";
import { postCapabilities } from "@/lib/forum/manage";
import { getPost, listBoards, listReplies } from "@/lib/forum/queries";
import { consentSummary } from "@/lib/forum/convert-queries";
import { pollOfPost } from "@/lib/forum/polls-queries";
import { tipsOfTargets } from "@/lib/forum/tips-queries";
import { isSubscribed } from "@/lib/forum/notify";
import { bookmarkOf, listFolders } from "@/lib/forum/bookmark-queries";
import { getDraft } from "@/lib/forum/drafts";
import { isBookmarked, reactionStates, readFloor } from "@/lib/forum/social-queries";
import { isIndexable } from "@/lib/forum/visibility";
import { recordView } from "@/lib/forum/actions";
import { CollapsedWrap } from "@/components/forum/CollapsedWrap";

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

export default async function PostPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ only?: string }>;
}) {
  const { id } = await params;
  const { only } = await searchParams;
  const user = await getCurrentUser();
  const viewer = buildViewerContext(user);

  const post = getPost(viewer, id);
  // 看不见与不存在给同样的 404 —— 403 会泄露「这个帖子存在」
  if (!post) notFound();

  const allReplies = listReplies(viewer, id);
  await recordView(id);

  // 只看楼主：走 URL 而不是客户端状态 —— 分享出去的链接也能带着这个视图
  const onlyAuthor = only === "op";
  const replies = onlyAuthor ? allReplies.filter((r) => r.authorId === post.authorId) : allReplies;

  // 一次查完整页的反应状态。逐条查的话，50 楼的帖子就是 200 次查询
  const reactionMap = reactionStates(
    [{ type: "post" as const, id: post.id }, ...replies.map((r) => ({ type: "reply" as const, id: r.id }))],
    user?.id ?? null,
  );
  const bookmarked = user ? isBookmarked(user.id, post.id) : false;
  const replyDraft = user ? getDraft(user.id, "reply", post.id) : null;
  // 收藏夹只在已经收藏时用得上，没收藏就不查
  const myFolders = user && bookmarked ? listFolders(user.id) : [];
  const myFolderId = user && bookmarked ? (bookmarkOf(user.id, post.id)?.folderId ?? null) : null;
  const subscribed = user ? isSubscribed(user.id, post.id) : false;
  const isAsker = user?.id === post.authorId;
  const consent = consentSummary(post.id, user?.wxId ?? null);
  const poll = pollOfPost(post.id, user?.id ?? null);
  const tipTotals = tipsOfTargets([
    { type: "post", id: post.id },
    ...replies.map((r) => ({ type: "reply" as const, id: r.id })),
  ]);
  const isQuestion = post.type === "question";
  const lastRead = user ? readFloor(user.id, post.id) : 0;
  const maxFloor = allReplies.length > 0 ? allReplies[allReplies.length - 1].floor : 0;

  // 能力集只决定按钮显不显示；每个 action 在服务端还会用 can() 再判一遍
  const caps = postCapabilities(user, post.raw);
  const moveTargets = caps.move
    ? listBoards(viewer)
        .filter((b) => b.id !== post.boardId && !b.locked)
        .map((b) => ({ id: b.id, name: b.name }))
    : [];

  const status = post.raw.status;

  /*
   * 分享。链接是有权限的 —— 对方点进来照样要过一遍收口，
   * 所以文案可以随便转；而**图片跑出去就收不回来**，
   * 所以草稿、已删除、私密一律不给生成。
   */
  const shareVerdict = canSharePost({
    visibility: post.visibility,
    status,
    viewerCanSee: true,
  });
  const shareUrl = `${env.site.url}/forum/p/${post.id}`;
  const shareCopy = shareText({
    kind: "post",
    title: post.title,
    url: shareUrl,
    excerpt: post.excerpt,
    siteName: env.site.name,
  });
  const locked = status === "locked";
  const deleted = status === "deleted";
  const canReply = Boolean(user) && !locked && !deleted;

  const note = VISIBILITY_NOTE[post.visibility];

  const body = (
    <>
      <BackLink href={`/forum/${post.boardKey}`}>{post.boardName}</BackLink>

      <article className="animate-rise pt-6">
        {deleted && (
          <div className="mb-4 flex items-start gap-2.5 rounded-[var(--radius-control)] bg-[var(--danger)]/10 px-3.5 py-3">
            <Trash2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--danger)]" strokeWidth={1.9} aria-hidden />
            <div>
              <p className="t-subhead font-medium text-[var(--danger)]">这篇帖子已被删除</p>
              {post.raw.deleteReason && (
                <p className="t-caption mt-0.5 text-[var(--ink-secondary)]">
                  理由：{post.raw.deleteReason}
                </p>
              )}
            </div>
          </div>
        )}

        {(post.pinned || post.featured || locked) && (
          <div className="mb-2.5 flex flex-wrap gap-1.5">
            {post.pinned && (
              <span className="t-caption inline-flex items-center gap-1 rounded-[var(--radius-pill)] bg-[var(--accent-soft)] px-2 py-0.5 font-medium text-[var(--accent)]">
                <Pin className="h-3 w-3" strokeWidth={2} aria-hidden />
                置顶
              </span>
            )}
            {post.featured && (
              <span className="t-caption inline-flex items-center gap-1 rounded-[var(--radius-pill)] bg-[var(--warning)]/15 px-2 py-0.5 font-medium text-[var(--warning)]">
                <Star className="h-3 w-3" strokeWidth={2} aria-hidden />
                精华
              </span>
            )}
            {locked && (
              <span className="t-caption inline-flex items-center gap-1 rounded-[var(--radius-pill)] bg-[var(--fill)] px-2 py-0.5 font-medium text-[var(--ink-secondary)]">
                <Lock className="h-3 w-3" strokeWidth={2} aria-hidden />
                已锁定
              </span>
            )}
          </div>
        )}

        <h1 className="t-title1 mb-3 leading-snug">{post.title}</h1>

        <div className="mb-5 flex items-center gap-2.5">
          <Avatar wxId={post.authorId} name={post.authorName} src={post.authorAvatar} size={32} />
          <div className="min-w-0 flex-1">
            <p className="t-subhead leading-tight">{post.authorName}</p>
            <p className="tabular t-caption text-[var(--ink-tertiary)]">
              {relativeTime(post.createdAt)}
              {post.raw.editCount > 0 && (
                <>
                  {" · "}
                  <Link
                    href={`/forum/p/${post.id}/history`}
                    className="text-[var(--accent)] underline decoration-[var(--accent)]/30 underline-offset-2"
                  >
                    编辑过 {post.raw.editCount} 次
                  </Link>
                </>
              )}
              {post.viewCount > 0 && ` · ${post.viewCount} 次浏览`}
            </p>
          </div>
        </div>

        <ConsentPanel postId={post.id} summary={consent} canModerate={viewer.canModerate} />

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

        {poll && <PollWidget poll={poll} canVote={Boolean(user)} />}

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <ReactionBar
            targetType="post"
            targetId={post.id}
            initial={reactionMap.get(post.id) ?? []}
            canReact={Boolean(user)}
          />
          {user && post.authorId !== user.id && (
            <TipButton
              targetType="post"
              targetId={post.id}
              balance={user.points}
              received={tipTotals.get(post.id) ?? 0}
            />
          )}
          <span className="flex items-center gap-1">
            <PostActions
              postId={post.id}
              bookmarked={bookmarked}
              subscribed={subscribed}
              canAct={Boolean(user)}
              folders={myFolders.map((x) => ({ id: x.id, name: x.name }))}
              folderId={myFolderId}
            />
            {user && post.authorId !== user.id && (
              <ReportButton targetType="post" targetId={post.id} />
            )}
            {shareVerdict.ok && (
              <ShareSheet
                url={shareUrl}
                text={shareCopy}
                imageUrl={`/api/share/post/${post.id}/card`}
              />
            )}
            <PostManageMenu
              postId={post.id}
              boardKey={post.boardKey}
              status={status}
              pinned={post.raw.pinned}
              featured={post.featured}
              caps={caps}
              boards={moveTargets}
            />
          </span>
        </div>
      </article>

      <Section
        title={allReplies.length ? `${allReplies.length} 条回复` : "回复"}
        className="mt-9"
      >
        {allReplies.length > 0 && (
          <div className="mb-3 flex items-center justify-between gap-3">
            {/* 和全站的筛选 Pill 同一个构件 —— 这里以前是手写的另一款药丸，
                选中态用 accent 而别处用 ink，同一种交互两种长相 */}
            <Pill
              href={onlyAuthor ? `/forum/p/${post.id}` : `/forum/p/${post.id}?only=op`}
              active={onlyAuthor}
            >
              只看楼主
            </Pill>
            {onlyAuthor && (
              <span className="t-caption text-[var(--ink-tertiary)]">
                楼主共 {replies.length} 条回复
              </span>
            )}
          </div>
        )}

        {user && !onlyAuthor && (
          <ResumeReading postId={post.id} lastReadFloor={lastRead} maxFloor={maxFloor} />
        )}

        {replies.length > 0 && (
          <div className="inset-group mb-4">
            {replies.map((reply) => (
              <ReplyRow
                key={reply.id}
                replyId={reply.id}
                floor={reply.floor}
                authorName={reply.authorName}
                isMine={reply.isMine}
                content={reply.content}
                /*
                 * 能不能改由服务端算 —— 客户端只管显示按钮。
                 * 时间窗判定也在服务端再走一遍，页面开着不动
                 * 半小时之后按钮还在，但保存会被拒。
                 */
                /* 能不能改在查询层算好 —— 和 isMine 一样，规则只有一处 */
                canEdit={reply.canEdit}
                canModerate={caps.moderateReplies}
              >
              {/*
                * 折叠的回复收成一行摘要。
                *
                * collapsed 这个列一直在库里、查询也读它，
                * 而界面上从来没渲染过 —— 折叠和不折叠长得一模一样，
                * 版主点了之后什么都不会发生。
                */}
              <CollapsedWrap
                collapsed={reply.collapsed}
                floor={reply.floor}
                authorName={reply.authorName}
                reason={reply.collapseReason}
              >
              <div
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
                  <QuoteButton replyId={reply.id} floor={reply.floor} authorName={reply.authorName} />
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

                {/*
                  * 改过就标出来。回复是对话的一部分 ——
                  * 悄悄改掉一条被引用过的回复，会让后面那串回应
                  * 看起来莫名其妙，而读的人只会觉得那些人在胡言乱语。
                  */}
                {reply.editCount > 0 && (
                  <p className="t-caption2 mt-1 text-[var(--ink-quaternary)]">
                    编辑过 {reply.editCount} 次
                  </p>
                )}

                <div className="mt-2 flex items-center justify-between gap-3">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <ReactionBar
                      targetType="reply"
                      targetId={reply.id}
                      initial={reactionMap.get(reply.id) ?? []}
                      canReact={Boolean(user)}
                      compact
                    />
                    {user && !reply.isMine && (
                      <TipButton
                        targetType="reply"
                        targetId={reply.id}
                        balance={user.points}
                        received={tipTotals.get(reply.id) ?? 0}
                      />
                    )}
                  </span>
                  <span className="tabular t-caption shrink-0 text-[var(--ink-quaternary)]">
                    {relativeTime(reply.createdAt)}
                  </span>
                </div>
              </div>
              </CollapsedWrap>
              </ReplyRow>
            ))}
          </div>
        )}

        {user ? (
          !deleted && <ReplyForm postId={post.id} locked={locked} serverDraft={replyDraft} />
        ) : (
          <Empty
            title="登录后参与讨论"
            action={<EmptyAction href="/login">登录</EmptyAction>}
          />
        )}
      </Section>
    </>
  );

  // 引用要在回复列表与回复框之间递状态，Provider 只在能回复时包 ——
  // 没有 Provider 时引用按钮整个不渲染，不会出现点了没反应的按钮
  return canReply ? <QuoteProvider>{body}</QuoteProvider> : body;
}
