import type { Metadata } from "next";
import Link from "next/link";

import { EscalationActions } from "@/components/admin/EscalationActions";
import { relativeTime } from "@/components/forum/PostList";
import { PageHeader } from "@/components/shell/PageHeader";
import { Empty, Pill } from "@/components/ui/primitives";
import { escalationFacets, escalationQueue } from "@/lib/admin/escalation";
import { requireAdmin } from "@/lib/admin/guard";
import { MAX_ESCALATION, statusLabel } from "@/lib/moderation/escalation-rules";
import { visibilityLabel } from "@/lib/admin/board-rules";

export const metadata: Metadata = { title: "可见性提升" };
export const dynamic = "force-dynamic";

/**
 * 可见性提升审核队列。
 *
 * 这是「群聊转帖锁定在原群」这条硬约束的**唯一出口**。
 * 页面开头就把边界讲清楚：最高只能到「仅成员」，
 * 永远不会公开 —— 群里说的话不该出现在搜索引擎里。
 *
 * 每一行摆出内容摘要和引用了几条原始消息。
 * 光看标题和申请理由回答不了「这段群聊值不值得给全体成员看」，
 * 只能靠印象点通过 —— 那这道审核就只是多了一步而已。
 */
export default async function AdminEscalationPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const admin = await requireAdmin("forum.visibility.review");
  const params = await searchParams;

  const rows = escalationQueue({ status: params.status, limit: 100 });
  const facets = escalationFacets();

  return (
    <>
      <PageHeader
        title="可见性提升"
        subtitle={facets.pending === 0 ? "没有待审核的申请" : `${facets.pending} 条待审核`}
      />

      <div className="mb-4 rounded-[var(--radius-card)] bg-[var(--surface)] p-4 hairline">
        <p className="t-subhead leading-relaxed">
          群聊转帖默认锁在原群范围，想让更多人看到只能走这条队列 ——
          最高到「{visibilityLabel(MAX_ESCALATION)}」，<strong>永远不会公开</strong>。
        </p>
        <p className="t-caption mt-1.5 leading-relaxed text-[var(--ink-tertiary)]">
          这不是配置项，是写死在代码里的硬约束。群里说的话不该出现在搜索引擎里 ——
          那不是「更多人能看到」，是「所有人永远都能搜到」，两回事。
          {facets.approveRate !== null && (
            <>
              {" "}
              已处理 {facets.handled} 条，通过率 {facets.approveRate}%。
              长期 100% 说明审核只是走过场；长期 0% 说明这条出口实际不存在，
              那大家就会绕过它 —— 比如直接把群聊内容复制成新帖。
            </>
          )}
        </p>
      </div>

      <div className="mb-5 flex flex-wrap gap-1.5">
        <Pill href="/admin/escalation" active={!params.status}>
          待审核 {facets.pending}
        </Pill>
        {facets.status
          .filter((s) => s.value !== "pending")
          .map((s) => (
            <Pill
              key={s.value}
              href={`/admin/escalation?status=${s.value}`}
              active={params.status === s.value}
            >
              {statusLabel(s.value)} {s.count}
            </Pill>
          ))}
      </div>

      {rows.length === 0 ? (
        <Empty
          title="没有待审核的申请"
          hint="队列空着可能是好事，也可能说明大家已经放弃走这条路了"
        />
      ) : (
        <div className="space-y-3">
          {rows.map((row) => {
            /*
             * 两条不能处理的情况在渲染时就说清楚，不是点下去才被拒绝：
             * 自己提的申请、以及自己就是转帖人。
             */
            const blocked =
              row.requestedBy === admin.user.id
                ? "这是你自己提交的申请，请交给其他管理员"
                : row.postAuthorId === admin.user.id
                  ? "这是你自己的帖子，不能自己批自己"
                  : null;

            return (
              <article
                key={row.id}
                className="space-y-3 rounded-[var(--radius-card)] bg-[var(--surface)] p-4 hairline"
              >
                <header className="flex flex-wrap items-baseline gap-1.5">
                  <Link href={`/forum/p/${row.postId}`} className="t-body font-medium">
                    {row.postTitle}
                  </Link>
                  <span className="t-caption text-[var(--ink-tertiary)]">
                    {row.boardName} · {row.fromLabel} → {row.toLabel}
                  </span>
                  <span className="t-caption ml-auto text-[var(--ink-quaternary)]">
                    等了 {row.waitingHours} 小时
                  </span>
                </header>

                {row.postExcerpt && (
                  <p className="t-subhead line-clamp-3 whitespace-pre-wrap rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 text-[var(--ink-secondary)]">
                    {row.postExcerpt}
                  </p>
                )}

                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2">
                    <p className="t-caption2 mb-1 text-[var(--ink-quaternary)]">
                      申请理由 · {row.requesterName} · {relativeTime(row.createdAt)}
                    </p>
                    <p className="t-subhead whitespace-pre-wrap text-[var(--ink-secondary)]">
                      {row.reason}
                    </p>
                  </div>

                  <div className="rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2">
                    <p className="t-caption2 mb-1 text-[var(--ink-quaternary)]">原作者同意</p>
                    <p className="tabular t-subhead">
                      {row.consent.granted} / {row.consent.required}
                      {row.consent.complete ? (
                        <span className="t-caption ml-1.5 text-[var(--success)]">已齐全</span>
                      ) : (
                        <span className="t-caption ml-1.5 text-[var(--warning)]">
                          还差 {row.consent.missing} 位
                        </span>
                      )}
                    </p>
                    <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--separator)]">
                      <div
                        className="h-full rounded-full transition-[width] duration-500"
                        style={{
                          width: `${row.consent.ratio * 100}%`,
                          background: row.consent.complete
                            ? "var(--success)"
                            : "var(--warning)",
                        }}
                      />
                    </div>
                    <p className="t-caption2 mt-1 text-[var(--ink-quaternary)]">
                      转帖引用了 {row.sourceMessages} 条原始消息
                    </p>
                  </div>
                </div>

                {row.status === "pending" ? (
                  <EscalationActions
                    id={row.id}
                    blocked={blocked}
                    consentMissing={row.consent.missing}
                  />
                ) : (
                  <p className="t-caption rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 text-[var(--ink-secondary)]">
                    {statusLabel(row.status)}：{row.reviewNote}
                  </p>
                )}
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}
