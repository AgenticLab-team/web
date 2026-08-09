import { PenLine } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { FollowButton } from "@/components/forum/FollowButton";
import { PostList } from "@/components/forum/PostList";
import { PageHeader } from "@/components/shell/PageHeader";
import { BackLink, Pill, PillRow, Section } from "@/components/ui/primitives";
import { getCurrentUser } from "@/lib/auth/session";
import { buildViewerContext } from "@/lib/forum/context";
import { isFollowing } from "@/lib/forum/follow";
import { getBoardByKey, listBoards, listPosts } from "@/lib/forum/queries";

const SORTS = [
  { key: "recent", label: "最新回复" },
  { key: "created", label: "最新发布" },
  { key: "hot", label: "最热" },
  { key: "unanswered", label: "无人回复" },
] as const;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ board: string }>;
}): Promise<Metadata> {
  const board = getBoardByKey((await params).board);
  return { title: board?.name ?? "版块" };
}

export const dynamic = "force-dynamic";

export default async function BoardPage({
  params,
  searchParams,
}: {
  params: Promise<{ board: string }>;
  searchParams: Promise<{ sort?: string }>;
}) {
  const { board: boardKey } = await params;
  const { sort } = await searchParams;

  const user = await getCurrentUser();
  const viewer = buildViewerContext(user);

  const board = getBoardByKey(boardKey);
  // 看不到的版块与不存在的版块给同样的结果，不泄露存在性
  if (!board || !listBoards(viewer).some((b) => b.id === board.id)) notFound();

  const following = user ? isFollowing(user.id, "board", board.id) : false;
  const activeSort = (SORTS.find((s) => s.key === sort)?.key ?? "recent") as "recent";
  const posts = listPosts(viewer, { boardId: board.id, sort: activeSort, limit: 30 });

  return (
    <>
      <BackLink href="/forum">论坛</BackLink>

      <PageHeader
        title={board.name}
        subtitle={board.description ?? undefined}
        action={
          user ? (
            <div className="flex shrink-0 items-center gap-2">
              {/* 关注排在发帖左边：发帖是这一页的主操作，主操作放最右边最好点 */}
              <FollowButton target="board" targetId={board.id} following={following} />
              <Link
                href={`/forum/new?board=${board.key}`}
                className="t-subhead flex shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] bg-[var(--accent)] px-3.5 py-2 font-medium text-[var(--accent-ink)] transition active:scale-[0.97]"
              >
                <PenLine className="h-4 w-4" strokeWidth={2} aria-hidden />
                发帖
              </Link>
            </div>
          ) : null
        }
      />

      <PillRow wrap>
        {SORTS.map((s) => (
          <Pill
            key={s.key}
            href={s.key === "recent" ? `/forum/${board.key}` : `/forum/${board.key}?sort=${s.key}`}
            active={s.key === activeSort}
          >
            {s.label}
          </Pill>
        ))}
      </PillRow>

      <Section>
        <PostList posts={posts} />
      </Section>
    </>
  );
}
