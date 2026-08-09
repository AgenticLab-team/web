import { MessageSquare } from "lucide-react";
import type { Metadata } from "next";

import { PageHeader } from "@/components/shell/PageHeader";
import { BackLink, Empty, Group, PageNote, Row, SearchField } from "@/components/ui/primitives";
import { requireFeature } from "@/lib/flags/server";
import { getCurrentUser } from "@/lib/auth/session";
import { buildViewerContext } from "@/lib/forum/context";
import { postsWithTag } from "@/lib/forum/tags-queries";
import { searchForum } from "@/lib/forum/search";

export const metadata: Metadata = { title: "搜索" };
export const dynamic = "force-dynamic";

export default async function ForumSearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; tag?: string }>;
}) {
  const { q, tag } = await searchParams;
  const user = await getCurrentUser();
  // 功能开关：关掉之后这一页 404 —— 只藏导航的话，地址栏敲一下照样进得去
  requireFeature("forum", user);
  const viewer = buildViewerContext(user);
  const query = (q ?? "").trim();
  const tagSlug = (tag ?? "").trim();

  /*
   * 按标签筛。
   *
   * 这个参数一直是**被静默丢弃**的：关注标签生成的链接、
   * 帖子上的标签、通知里的链接都指向 `?tag=xxx`，
   * 而这一页只读 `q` —— 于是每一次点标签，人都落在一个空搜索框上，
   * 看起来像「这个标签下什么都没有」。
   */
  const tagged = tagSlug ? postsWithTag(viewer, tagSlug, 40) : [];
  const hits = query ? searchForum(viewer, query, 40) : [];

  return (
    <>
      <BackLink href="/forum">论坛</BackLink>

      <PageHeader
        title={tagSlug ? `标签：${tagSlug}` : "搜索"}
        subtitle={
          tagSlug
            ? `${tagged.length} 篇`
            : query
              ? `“${query}” · ${hits.length} 条结果`
              : undefined
        }
      />

      <form action="/forum/search" className="mb-6">
        <SearchField
          defaultValue={query}
          placeholder="搜标题与正文，支持中文两字词"
          autoFocus={!query}
        />
      </form>

      {tagSlug ? (
        tagged.length === 0 ? (
          /*
           * 空标签页要说清楚是「没有」，不是「坏了」——
           * 而且给一条出路：这一页是从别处点进来的，
           * 人多半不想再手敲一个关键词。
           */
          <Empty title={`还没有帖子用「${tagSlug}」这个标签`} hint="发帖时可以加上它" />
        ) : (
          <Group>
            {tagged.map((post) => (
              <Row key={post.id} href={`/forum/p/${post.id}`}>
                <div className="min-w-0 flex-1">
                  <p className="t-body leading-snug">{post.title}</p>
                  <p className="t-caption2 mt-0.5 text-[var(--ink-tertiary)]">{post.boardName}</p>
                </div>
              </Row>
            ))}
          </Group>
        )
      ) : !query ? (
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
