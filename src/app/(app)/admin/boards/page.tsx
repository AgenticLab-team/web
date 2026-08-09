import { Folder } from "lucide-react";
import type { Metadata } from "next";

import { BoardEditor } from "@/components/admin/BoardEditor";
import { BoardModerators } from "@/components/admin/BoardModerators";
import { TagManager } from "@/components/admin/TagManager";
import { PageHeader } from "@/components/shell/PageHeader";
import { Callout, Card, Empty, Section } from "@/components/ui/primitives";
import { VISIBILITY_OPTIONS, visibilityLabel } from "@/lib/admin/board-rules";
import { capImpact, listBoardsForAdmin, listTagsForAdmin, orphanTags } from "@/lib/admin/boards";
import { requireAdmin } from "@/lib/admin/guard";
import { moderatorCandidates, moderatorsOf } from "@/lib/admin/moderators";
import { VISIBILITY_LEVELS } from "@/lib/db/schema/forum";

export const metadata: Metadata = { title: "版块与标签" };
export const dynamic = "force-dynamic";

/**
 * 版块与标签管理。
 *
 * 两件事在这一页上必须看得见：
 *
 *   1. **改可见性上限的影响面** —— 在保存前算好，见 BoardEditor。
 *      改配置也是对别人内容的操作。
 *   2. **冗余计数与真实计数的差** —— 版块的 post_count 漂移过一次
 *      （「群聊沉淀」实际 2 篇却显示 0），所以这里两个数都摆出来，
 *      不一致就标黄。修好一次不代表以后不会再漂。
 */
export default async function AdminBoardsPage() {
  const admin = await requireAdmin("forum.board.manage");

  const boards = listBoardsForAdmin();
  const tags = listTagsForAdmin();
  const orphans = orphanTags();

  const drifted = boards.filter((b) => b.livePosts !== b.cachedCount);

  return (
    <>
      <PageHeader
        title="版块与标签"
        subtitle={`${boards.length} 个版块 · ${tags.length} 个标签`}
      />

      {drifted.length > 0 && (
        <Callout tone="warning" title={`${drifted.length} 个版块的帖子数对不上`}>
          <p className="t-caption mt-1 leading-relaxed text-[var(--ink-secondary)]">
            {drifted.map((b) => `${b.name} ${b.cachedCount}→${b.livePosts}`).join("、")}。
            在服务器上跑 <code className="font-mono">npm run recount-boards</code> 修正。
            这个数漂过一次，表现是「群聊沉淀」实际有帖子却显示 0 ——
            0 被当成了「确实没有」。
          </p>
        </Callout>
      )}

      <Section title="版块">
        {boards.length === 0 ? (
          <Empty title="还没有版块" />
        ) : (
          <div className="space-y-2.5">
            {boards.map((board) => (
              <Card as="article" key={board.id}>
                <header className="flex items-start gap-3">
                  {board.icon ? (
                    <span className="text-[22px] leading-none">{board.icon}</span>
                  ) : (
                    /* 版块自定义图标是运营填的，可以是 emoji；没填时的兜底用 SVG，
                       和后台其它地方保持同一套线条 */
                    <Folder className="h-5 w-5 text-[var(--ink-tertiary)]" strokeWidth={2} aria-hidden />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="t-body flex flex-wrap items-center gap-1.5">
                      <span className="truncate font-medium">{board.name}</span>
                      <span className="t-caption2 font-mono text-[var(--ink-quaternary)]">
                        {board.key}
                      </span>
                      {board.locked && (
                        <span className="t-caption2 text-[var(--warning)]">已锁定</span>
                      )}
                    </p>
                    {board.description && (
                      <p className="t-caption mt-0.5 truncate text-[var(--ink-tertiary)]">
                        {board.description}
                      </p>
                    )}
                    <p className="tabular t-caption mt-1 text-[var(--ink-quaternary)]">
                      {board.livePosts} 篇 · 可见 {visibilityLabel(board.visibleTo)} · 封顶{" "}
                      {visibilityLabel(board.maxVisibility)} · 发帖 L{board.postMinLevel}+
                      {board.childCount > 0 && ` · ${board.childCount} 个子版块`}
                    </p>
                  </div>
                  <BoardEditor
                    board={board}
                    siblings={boards
                      .filter((b) => b.id !== board.id)
                      .map((b) => ({ id: b.id, name: b.name }))}
                    impacts={Object.fromEntries(
                      VISIBILITY_LEVELS.filter((v) => v !== board.maxVisibility).map((v) => [
                        v,
                        capImpact(board.id, v),
                      ]),
                    )}
                  />
                </header>

                {admin.has("role.grant") && (
                  <BoardModerators
                    boardId={board.id}
                    boardName={board.name}
                    moderators={moderatorsOf(board.id)}
                    candidates={moderatorCandidates(board.id)}
                  />
                )}
              </Card>
            ))}
          </div>
        )}
        <p className="t-caption mt-2 px-1 leading-relaxed text-[var(--ink-tertiary)]">
          版块标识（key）建好之后不能改 —— 它在 URL 里，改了等于把所有旧链接作废。
          可见性上限是<strong>封顶</strong>：帖子想公开但版块只允许到「
          {VISIBILITY_OPTIONS.find((o) => o.key === "member")?.label}」时，结果就是后者。
        </p>
      </Section>

      <Section title="标签">
        {admin.has("forum.tag.manage") ? (
          <TagManager
            tags={tags.map((t) => ({
              id: t.id,
              name: t.name,
              slug: t.slug,
              locked: t.locked,
              liveCount: t.liveCount,
              cachedCount: t.cachedCount,
            }))}
            orphanCount={orphans.length}
          />
        ) : (
          <p className="t-caption px-1 text-[var(--ink-tertiary)]">
            你没有管理标签的权限，只能查看。
          </p>
        )}
      </Section>
    </>
  );
}
