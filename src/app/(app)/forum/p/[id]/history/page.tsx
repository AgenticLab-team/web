import { desc, eq, inArray } from "drizzle-orm";
import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { relativeTime } from "@/components/forum/PostList";
import { PageHeader } from "@/components/shell/PageHeader";
import { Empty, Section } from "@/components/ui/primitives";
import { getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { postRevisions, users } from "@/lib/db/schema";
import { collapseUnchanged, diffLines, diffStats } from "@/lib/diff";
import { buildViewerContext } from "@/lib/forum/context";
import { getPost } from "@/lib/forum/queries";

export const metadata: Metadata = { title: "编辑历史" };
export const dynamic = "force-dynamic";

/**
 * 公开的编辑历史。
 *
 * 悄悄改内容是论坛信任的头号杀手 —— 有人回复了你，
 * 你把原帖改成别的意思，整串对话就废了。
 * 所以历史对**所有能看到这个帖子的人**开放，不只是作者和管理员。
 */
export default async function HistoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  const viewer = buildViewerContext(user);

  const post = getPost(viewer, id);
  if (!post) notFound();

  const revisions = db
    .select()
    .from(postRevisions)
    .where(eq(postRevisions.postId, id))
    .orderBy(desc(postRevisions.createdAt))
    .all();

  const editorIds = [...new Set(revisions.map((r) => r.editorId))];
  const editors = new Map(
    editorIds.length
      ? db
          .select({ id: users.id, name: users.siteNickname, wx: users.wxNickname })
          .from(users)
          .where(inArray(users.id, editorIds))
          .all()
          .map((u) => [u.id, u.name ?? u.wx ?? "成员"])
      : [],
  );

  // 每个版本与它的下一个状态对比：最新版本对比当前正文
  const timeline = revisions.map((revision, index) => {
    const newer = index === 0 ? post.content : revisions[index - 1].content;
    const lines = diffLines(revision.content, newer);
    return {
      revision,
      editor: editors.get(revision.editorId) ?? "成员",
      lines: collapseUnchanged(lines),
      stats: diffStats(lines),
      newerTitle: index === 0 ? post.title : revisions[index - 1].title,
    };
  });

  return (
    <>
      <Link
        href={`/forum/p/${id}`}
        className="t-subhead -ml-1 mt-6 inline-flex items-center gap-0.5 text-[var(--accent)] transition active:opacity-60"
      >
        <ChevronLeft className="h-4 w-4" strokeWidth={2.2} aria-hidden />
        返回帖子
      </Link>

      <PageHeader
        title="编辑历史"
        subtitle={`${post.title} · 共 ${revisions.length} 次编辑`}
      />

      {timeline.length === 0 ? (
        <Empty title="这篇帖子从未编辑过" hint="发布之后的每一次修改都会记录在这里" />
      ) : (
        timeline.map(({ revision, editor, lines, stats, newerTitle }) => (
          <Section key={revision.id}>
            <div className="inset-group overflow-hidden">
              <div className="inset-row flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-3">
                <span className="t-subhead">{editor}</span>
                <span className="tabular t-caption text-[var(--ink-tertiary)]">
                  {relativeTime(revision.createdAt)}
                </span>
                <span className="flex-1" />
                <span className="tabular t-caption text-[var(--success)]">+{stats.added}</span>
                <span className="tabular t-caption text-[var(--danger)]">−{stats.removed}</span>
              </div>

              {revision.title !== newerTitle && (
                <div className="inset-row px-4 py-2.5">
                  <p className="t-caption text-[var(--ink-tertiary)]">标题</p>
                  <p className="t-footnote mt-0.5 text-[var(--danger)] line-through">
                    {revision.title}
                  </p>
                  <p className="t-footnote text-[var(--success)]">{newerTitle}</p>
                </div>
              )}

              {revision.changeNote && (
                <div className="inset-row px-4 py-2.5">
                  <p className="t-footnote text-[var(--ink-secondary)]">
                    说明：{revision.changeNote}
                  </p>
                </div>
              )}

              <div className="inset-row overflow-x-auto">
                <pre className="t-footnote font-mono leading-relaxed">
                  {lines.map((line, index) =>
                    line.kind === "gap" ? (
                      <div
                        key={index}
                        className="bg-[var(--fill)] px-4 py-1 text-center text-[var(--ink-quaternary)]"
                      >
                        ⋯ 未改动的 {line.count} 行
                      </div>
                    ) : (
                      <div
                        key={index}
                        className={`px-4 py-0.5 ${
                          line.kind === "add"
                            ? "bg-[var(--success)]/10 text-[var(--success)]"
                            : line.kind === "remove"
                              ? "bg-[var(--danger)]/10 text-[var(--danger)]"
                              : "text-[var(--ink-secondary)]"
                        }`}
                      >
                        <span className="select-none opacity-50">
                          {line.kind === "add" ? "+ " : line.kind === "remove" ? "− " : "  "}
                        </span>
                        {line.text || " "}
                      </div>
                    ),
                  )}
                </pre>
              </div>
            </div>
          </Section>
        ))
      )}

      <p className="t-caption px-1 leading-relaxed text-[var(--ink-tertiary)]">
        编辑历史对所有能看到这篇帖子的人开放。
        这样别人回复你之后，你就没法悄悄把原帖改成另一个意思。
      </p>
    </>
  );
}
