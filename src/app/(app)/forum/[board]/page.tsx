import { ChevronLeft, PenLine } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PostList } from "@/components/forum/PostList";
import { PageHeader } from "@/components/shell/PageHeader";
import { Pill, Section } from "@/components/ui/primitives";
import { getCurrentUser } from "@/lib/auth/session";
import { buildViewerContext } from "@/lib/forum/context";
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

  const activeSort = (SORTS.find((s) => s.key === sort)?.key ?? "recent") as "recent";
  const posts = listPosts(viewer, { boardId: board.id, sort: activeSort, limit: 30 });

  return (
    <>
      <Link
        href="/forum"
        className="t-subhead -ml-1 mt-6 inline-flex items-center gap-0.5 text-[var(--accent)] transition active:opacity-60"
      >
        <ChevronLeft className="h-4 w-4" strokeWidth={2.2} aria-hidden />
        论坛
      </Link>

      <PageHeader
        title={board.name}
        subtitle={board.description ?? undefined}
        action={
          user ? (
            <Link
              href={`/forum/new?board=${board.key}`}
              className="t-subhead flex shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] bg-[var(--accent)] px-3.5 py-2 font-medium text-[var(--accent-ink)] transition active:scale-[0.97]"
            >
              <PenLine className="h-4 w-4" strokeWidth={2} aria-hidden />
              发帖
            </Link>
          ) : null
        }
      />

      <div className="mb-5 flex flex-wrap gap-1.5">
        {SORTS.map((s) => (
          <Pill
            key={s.key}
            href={s.key === "recent" ? `/forum/${board.key}` : `/forum/${board.key}?sort=${s.key}`}
            active={s.key === activeSort}
          >
            {s.label}
          </Pill>
        ))}
      </div>

      <Section>
        <PostList posts={posts} />
      </Section>
    </>
  );
}
