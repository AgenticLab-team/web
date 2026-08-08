import { PenLine, Search } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { PostList } from "@/components/forum/PostList";
import { PageHeader } from "@/components/shell/PageHeader";
import { Group, Row, Section } from "@/components/ui/primitives";
import { getCurrentUser } from "@/lib/auth/session";
import { buildViewerContext } from "@/lib/forum/context";
import { listBoards, listPosts } from "@/lib/forum/queries";

export const metadata: Metadata = { title: "论坛" };
export const dynamic = "force-dynamic";

export default async function ForumPage() {
  const user = await getCurrentUser();
  const viewer = buildViewerContext(user);
  const boards = listBoards(viewer);
  const recent = listPosts(viewer, { sort: "recent", limit: 15 });

  return (
    <>
      <PageHeader
        title="论坛"
        subtitle="群聊留不住的东西，放在这里"
        action={
          <span className="flex shrink-0 items-center gap-2">
            <Link
              href="/forum/search"
              aria-label="搜索"
              className="rounded-[var(--radius-control)] bg-[var(--fill)] p-2 text-[var(--ink-secondary)] transition active:scale-[0.95]"
            >
              <Search className="h-4 w-4" strokeWidth={2} aria-hidden />
            </Link>
            {user ? (
            <Link
              href="/forum/new"
              className="t-subhead flex shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] bg-[var(--accent)] px-3.5 py-2 font-medium text-[var(--accent-ink)] transition active:scale-[0.97]"
            >
              <PenLine className="h-4 w-4" strokeWidth={2} aria-hidden />
              发帖
            </Link>
            ) : null}
          </span>
        }
      />

      <Section title="版块">
        <Group>
          {boards.map((board) => (
            <Row key={board.id} href={`/forum/${board.key}`}>
              <div className="min-w-0 flex-1">
                <p className="t-body leading-tight">{board.name}</p>
                {board.description && (
                  <p className="t-caption mt-0.5 truncate text-[var(--ink-tertiary)]">
                    {board.description}
                  </p>
                )}
              </div>
              <span className="tabular t-caption shrink-0 text-[var(--ink-tertiary)]">
                {board.postCount}
              </span>
            </Row>
          ))}
        </Group>
      </Section>

      <Section title="最新讨论">
        <PostList posts={recent} showBoard />
      </Section>
    </>
  );
}
