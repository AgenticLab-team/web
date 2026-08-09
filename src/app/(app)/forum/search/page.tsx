import { MessageSquare } from "lucide-react";
import type { Metadata } from "next";

import { PageHeader } from "@/components/shell/PageHeader";
import { BackLink, Empty, Group, PageNote, Row, SearchField } from "@/components/ui/primitives";
import { getCurrentUser } from "@/lib/auth/session";
import { buildViewerContext } from "@/lib/forum/context";
import { searchForum } from "@/lib/forum/search";

export const metadata: Metadata = { title: "搜索" };
export const dynamic = "force-dynamic";

export default async function ForumSearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const user = await getCurrentUser();
  const viewer = buildViewerContext(user);
  const query = (q ?? "").trim();
  const hits = query ? searchForum(viewer, query, 40) : [];

  return (
    <>
      <BackLink href="/forum">论坛</BackLink>

      <PageHeader title="搜索" subtitle={query ? `“${query}” · ${hits.length} 条结果` : undefined} />

      <form action="/forum/search" className="mb-6">
        <SearchField
          defaultValue={query}
          placeholder="搜标题与正文，支持中文两字词"
          autoFocus={!query}
        />
      </form>

      {!query ? (
        <Empty title="输入关键词开始搜索" hint="只会搜到你有权限看的内容" />
      ) : hits.length === 0 ? (
        <Empty title="没有找到相关内容" hint="换个说法，或者试试更短的词" />
      ) : (
        <Group>
          {hits.map((hit) => (
            <Row key={hit.postId} href={`/forum/p/${hit.postId}`}>
              <div className="min-w-0 flex-1">
                <p className="t-body leading-snug">{hit.title}</p>
                {hit.excerpt && (
                  <p className="t-caption mt-0.5 line-clamp-2 text-[var(--ink-tertiary)]">
                    {hit.excerpt}
                  </p>
                )}
              </div>
              {hit.matchedInReply && (
                <span
                  className="t-caption flex shrink-0 items-center gap-1 text-[var(--ink-quaternary)]"
                  title="在回复中匹配"
                >
                  <MessageSquare className="h-3.5 w-3.5" strokeWidth={1.9} aria-hidden />
                </span>
              )}
            </Row>
          ))}
        </Group>
      )}

      <PageNote>
        搜索结果按可见性过滤 —— 你看不到的内容不会出现在这里，连标题也不会。
      </PageNote>
    </>
  );
}
