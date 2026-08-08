import type { Metadata } from "next";
import Link from "next/link";

import { ReportActions } from "@/components/admin/ReportActions";
import { relativeTime } from "@/components/forum/PostList";
import { PageHeader } from "@/components/shell/PageHeader";
import { Empty, Pill } from "@/components/ui/primitives";
import { requireAdmin } from "@/lib/admin/guard";
import { reportFacets, reportQueue, reportsForTarget } from "@/lib/admin/reports";
import { severityLabel } from "@/lib/moderation/rules";

export const metadata: Metadata = { title: "举报队列" };
export const dynamic = "force-dynamic";

/**
 * 举报队列。
 *
 * 一行一个**目标**，不是一行一条举报 —— 十个人举报同一条内容，
 * 版主只该看见一件事。
 *
 * 页面顶部四个数字都是筛选入口；「超时」排第一，因为它是唯一一个
 * 会随时间自己变糟的指标。
 */

const SEVERITY_COLOR: Record<number, string> = {
  2: "var(--danger)",
  1: "var(--warning)",
};

const TARGET_LABEL: Record<string, string> = { post: "帖子", reply: "回复", user: "用户" };

export default async function AdminReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string; type?: string; status?: string }>;
}) {
  const admin = await requireAdmin("moderation.queue");
  const params = await searchParams;

  const rows = reportQueue({
    reasonCode: params.reason,
    targetType: params.type,
    status: params.status,
    limit: 100,
  });
  const facets = reportFacets();

  const href = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams();
    const merged = { reason: params.reason, type: params.type, status: params.status, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) next.set(k, v);
    const qs = next.toString();
    return qs ? `/admin/reports?${qs}` : "/admin/reports";
  };

  return (
    <>
      <PageHeader
        title="举报队列"
        subtitle={facets.pending === 0 ? "队列是空的" : `${facets.pending} 件待处理`}
      />

      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Metric label="超时未处理" value={facets.overdue} tone={facets.overdue > 0 ? "danger" : undefined} />
        <Metric label="紧急" value={facets.urgent} tone={facets.urgent > 0 ? "warning" : undefined} />
        <Metric label="无人认领" value={facets.unassigned} />
        <Metric label="待处理" value={facets.pending} />
      </div>

      <div className="-mx-4 mb-5 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
        <span className="shrink-0">
          <Pill href={href({ reason: undefined })} active={!params.reason}>
            全部理由
          </Pill>
        </span>
        {facets.reasons.map((f) => (
          <span key={f.code} className="shrink-0">
            <Pill href={href({ reason: f.code })} active={params.reason === f.code}>
              {f.label} {f.count}
            </Pill>
          </span>
        ))}
      </div>

      {rows.length === 0 ? (
        <Empty
          title="没有待处理的举报"
          hint="队列空着是好事 —— 但也别忘了确认举报入口本身还能用"
        />
      ) : (
        <div className="space-y-3">
          {rows.map((row) => {
            const detail = reportsForTarget(row.targetType, row.targetId);
            const reporterIds = new Set(detail.map((d) => d.reporterId));

            // 利益冲突在渲染时就说清楚，不是点下去才被拒绝
            const conflict = reporterIds.has(admin.user.id)
              ? "你是这批举报的举报人之一，请交给其他管理员处理"
              : row.targetUserId === admin.user.id
                ? "这是针对你自己的举报，请交给其他管理员处理"
                : null;

            return (
              <article
                key={row.key}
                className="space-y-3 rounded-[var(--radius-card)] bg-[var(--surface)] p-4 hairline"
                style={
                  row.overdue
                    ? { boxShadow: "inset 3px 0 0 0 var(--danger)" }
                    : undefined
                }
              >
                <header className="flex flex-wrap items-center gap-1.5">
                  {row.severity > 0 && (
                    <span
                      className="t-caption2 rounded-[var(--radius-pill)] px-1.5 py-0.5 font-medium"
                      style={{
                        background: `color-mix(in srgb, ${SEVERITY_COLOR[row.severity]} 15%, transparent)`,
                        color: SEVERITY_COLOR[row.severity],
                      }}
                    >
                      {severityLabel(row.severity)}
                      {row.severity > row.baseSeverity && " · 多人举报"}
                    </span>
                  )}
                  {row.overdue && (
                    <span className="t-caption2 font-medium text-[var(--danger)]">已超时</span>
                  )}
                  <span className="t-caption text-[var(--ink-tertiary)]">
                    {TARGET_LABEL[row.targetType] ?? row.targetType} ·{" "}
                    {row.reasons.map((r) => `${r.label}×${r.count}`).join("、")}
                  </span>
                  <span className="t-caption ml-auto text-[var(--ink-quaternary)]">
                    {relativeTime(row.firstReportedAt)}
                  </span>
                </header>

                {row.preview && (
                  <p className="t-subhead line-clamp-3 whitespace-pre-wrap rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 text-[var(--ink-secondary)]">
                    {row.preview}
                  </p>
                )}

                <p className="t-caption text-[var(--ink-tertiary)]">
                  {row.targetUserId ? (
                    <Link href={`/admin/users/${row.targetUserId}`} className="underline">
                      {row.targetUserName}
                    </Link>
                  ) : (
                    "未知作者"
                  )}
                  {" · "}
                  {row.reporterCount} 人举报
                  {row.priorActions > 0 && ` · 此前被处理过 ${row.priorActions} 次`}
                  {row.targetGone && " · 内容已被删除或隐藏"}
                  {row.assignedTo && " · 已有人认领"}
                </p>

                {row.details.length > 0 && (
                  <ul className="space-y-1">
                    {row.details.slice(0, 3).map((d, i) => (
                      <li key={i} className="t-caption text-[var(--ink-secondary)]">
                        「{d}」
                      </li>
                    ))}
                  </ul>
                )}

                {row.targetType === "post" && (
                  <Link
                    href={`/forum/p/${row.targetId}`}
                    className="t-caption inline-block text-[var(--accent)]"
                  >
                    查看原帖 →
                  </Link>
                )}

                <ReportActions
                  targetType={row.targetType}
                  targetId={row.targetId}
                  assigned={row.assignedTo !== null}
                  conflict={conflict}
                />
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "danger" | "warning";
}) {
  const color = tone === "danger" ? "var(--danger)" : tone === "warning" ? "var(--warning)" : undefined;
  return (
    <div className="rounded-[var(--radius-card)] bg-[var(--surface)] px-3 py-2.5 hairline">
      <p className="tabular t-title3 leading-none" style={color ? { color } : undefined}>
        {value}
      </p>
      <p className="t-caption mt-1 text-[var(--ink-tertiary)]">{label}</p>
    </div>
  );
}
