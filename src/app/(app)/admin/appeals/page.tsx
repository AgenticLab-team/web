import type { Metadata } from "next";
import Link from "next/link";

import { AppealActions } from "@/components/admin/AppealActions";
import { relativeTime } from "@/components/forum/PostList";
import { PageHeader } from "@/components/shell/PageHeader";
import { Empty, Pill } from "@/components/ui/primitives";
import { actionLabel, appealFacets, appealQueue } from "@/lib/admin/appeals";
import { requireAdmin } from "@/lib/admin/guard";

export const metadata: Metadata = { title: "申诉" };
export const dynamic = "force-dynamic";

/**
 * 申诉队列。
 *
 * 每一条都把**原处罚的理由**和**申诉人的说法**并排放在一起。
 * 只看其中一边，判断只能靠印象。
 *
 * 页面上常驻采纳率。它不是 KPI ——
 * 长期 0% 说明申诉只是走过场，长期很高说明处罚本身太随意，
 * 两头都不对，所以要让人一直看得见。
 */

export default async function AdminAppealsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const admin = await requireAdmin("moderation.appeal");
  const params = await searchParams;

  const rows = appealQueue({ status: params.status, limit: 100 });
  const facets = appealFacets();

  return (
    <>
      <PageHeader
        title="申诉"
        subtitle={facets.open === 0 ? "没有待处理的申诉" : `${facets.open} 条待处理`}
      />

      <div className="mb-4 rounded-[var(--radius-card)] bg-[var(--surface)] px-4 py-3 hairline">
        <p className="t-subhead">
          {facets.acceptRate === null ? (
            <>还没有处理过申诉</>
          ) : (
            <>
              已处理 {facets.handled} 条，采纳率{" "}
              <span className="tabular font-medium">{facets.acceptRate}%</span>
            </>
          )}
        </p>
        <p className="t-caption mt-1 text-[var(--ink-tertiary)]">
          采纳率长期为 0 说明申诉是走过场；长期很高说明处罚本身太随意。它不是考核指标。
        </p>
      </div>

      <div className="mb-5 flex flex-wrap gap-1.5">
        <Pill href="/admin/appeals" active={!params.status}>
          待处理 {facets.open}
        </Pill>
        {facets.status
          .filter((s) => s.value !== "open")
          .map((s) => (
            <Pill
              key={s.value}
              href={`/admin/appeals?status=${s.value}`}
              active={params.status === s.value}
            >
              {s.value === "accepted" ? "已采纳" : "已驳回"} {s.count}
            </Pill>
          ))}
      </div>

      {rows.length === 0 ? (
        <Empty title="没有待处理的申诉" hint="有处罚就必须有申诉入口，空着说明处罚都被接受了" />
      ) : (
        <div className="space-y-3">
          {rows.map((row) => {
            /*
             * 两条不能处理的情况在这里就判定好：
             * 原处罚人复核自己的决定，以及申诉人自己处理自己的申诉。
             */
            const blocked =
              row.punisherId === admin.user.id
                ? "这条处罚是你下的，不能由你复核 —— 请交给其他管理员"
                : row.userId === admin.user.id
                  ? "这是你自己的申诉"
                  : null;

            return (
              <article
                key={row.id}
                className="space-y-3 rounded-[var(--radius-card)] bg-[var(--surface)] p-4 hairline"
              >
                <header className="flex flex-wrap items-baseline gap-1.5">
                  <Link href={`/admin/users/${row.userId}`} className="t-body font-medium">
                    {row.userName}
                  </Link>
                  <span className="t-caption text-[var(--ink-tertiary)]">
                    申诉「{actionLabel(row.actionKind)}」
                  </span>
                  <span className="t-caption ml-auto text-[var(--ink-quaternary)]">
                    等了 {row.waitingHours} 小时
                  </span>
                </header>

                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2">
                    <p className="t-caption2 mb-1 text-[var(--ink-quaternary)]">
                      原处罚理由 · {row.punisherName} · {relativeTime(row.actionAt)}
                    </p>
                    <p className="t-subhead whitespace-pre-wrap text-[var(--ink-secondary)]">
                      {row.actionReason}
                    </p>
                  </div>
                  <div className="rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2">
                    <p className="t-caption2 mb-1 text-[var(--ink-quaternary)]">
                      申诉人的说法 · {relativeTime(row.createdAt)}
                    </p>
                    <p className="t-subhead whitespace-pre-wrap text-[var(--ink-secondary)]">
                      {row.content}
                    </p>
                  </div>
                </div>

                {row.alreadyReverted && (
                  <p className="t-caption text-[var(--ink-tertiary)]">
                    这条处罚已经被撤销了 —— 申诉可能已无实际影响，但仍要给出答复。
                  </p>
                )}

                {row.status === "open" ? (
                  <AppealActions appealId={row.id} blocked={blocked} />
                ) : (
                  <p className="t-caption rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 text-[var(--ink-secondary)]">
                    {row.status === "accepted" ? "已采纳" : "已驳回"}：{row.response}
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
