import type { Metadata } from "next";
import Link from "next/link";

import { ReportActions } from "@/components/admin/ReportActions";
import { relativeTime } from "@/components/forum/PostList";
import { PageHeader } from "@/components/shell/PageHeader";
import { TruncationNote } from "@/components/ui/Pagination";
import { Callout, Card, Empty, Pill, PillRow, StatTile } from "@/components/ui/primitives";
import { awaitingConsent, readyToRaise } from "@/lib/forum/consent-queue";
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

  /*
   * 这个队列不做页码分页：行是按目标归组、按严重度排序出来的，
   * offset 落在组的中间没有意义。它按设计只显示「最该处理的前一批」——
   * 但截断必须说出来，所以先取全量（有上限护栏）再截，差额摆在列表尾部。
   */
  const fullQueue = reportQueue({
    reasonCode: params.reason,
    targetType: params.type,
    status: params.status,
    limit: 500,
  });
  const rows = fullQueue.slice(0, 100);
  const facets = reportFacets();

  const href = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams();
    const merged = { reason: params.reason, type: params.type, status: params.status, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) next.set(k, v);
    const qs = next.toString();
    return qs ? `/admin/reports?${qs}` : "/admin/reports";
  };

  /*
   * 「全员已同意，等人提升可见范围」的那一批。
   *
   * 放在举报队列这一页，而不是新开一页：两者是同一类工作 ——
   * **有人在等一个治理决定**。多开一页的结果是那一页没人每天看，
   * 而这件事的失败方式恰恰是「没人看见」。
   */
  const ready = readyToRaise();
  const waiting = awaitingConsent();

  return (
    <>
      <PageHeader
        title="举报队列"
        subtitle={facets.pending === 0 ? "队列是空的" : `${facets.pending} 件待处理`}
      />

      <div className="mb-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <StatTile label="超时未处理" value={facets.overdue} tone={facets.overdue > 0 ? "danger" : undefined} />
        <StatTile label="紧急" value={facets.urgent} tone={facets.urgent > 0 ? "warning" : undefined} />
        <StatTile label="无人认领" value={facets.unassigned} />
        <StatTile label="待处理" value={facets.pending} />
      </div>

      {ready.length > 0 && (
        <Callout tone="accent" title={`${ready.length} 篇群聊整理帖等着提升可见范围`}>
          <p className="t-caption mt-1 leading-relaxed text-[var(--ink-secondary)]">
            每一位被引用的原作者都已经同意了，而<strong>提升可见范围的按钮只有版主看得到</strong> ——
            没有人处理的话，它会一直停在「只有原群成员可见」。
            整理的人那一侧看到的是「N/N 位原作者同意公开」，
            一个看起来该公开却没公开的状态，读起来像是坏了。
          </p>
          <ul className="mt-2 space-y-1">
            {ready.map((r) => (
              <li key={r.postId}>
                <Link
                  href={`/forum/p/${r.postId}`}
                  className="t-footnote text-[var(--accent)] transition active:opacity-60"
                >
                  {r.title}
                </Link>
                <span className="t-caption2 ml-1.5 text-[var(--ink-tertiary)]">
                  {r.boardName} · {r.authors} 位原作者已同意
                  {r.boardMax !== "public" && ` · 这个版块最高只到 ${r.boardMax}`}
                </span>
              </li>
            ))}
          </ul>
        </Callout>
      )}

      {waiting.length > 0 && (
        <p className="t-caption mb-3 px-1 leading-relaxed text-[var(--ink-tertiary)]">
          另有 {waiting.length} 篇还在等原作者表态（共 {waiting.reduce((n, w) => n + w.pending, 0)} 位未回应）——
          这一步不该催，被引用的人有权不表态。
        </p>
      )}

      <PillRow>
        <Pill href={href({ reason: undefined })} active={!params.reason}>
          全部理由
        </Pill>
        {facets.reasons.map((f) => (
          <Pill key={f.code} href={href({ reason: f.code })} active={params.reason === f.code}>
            {f.label} {f.count}
          </Pill>
        ))}
      </PillRow>

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
              <Card
                as="article"
                key={row.key}
                className="space-y-3"
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
              </Card>
            );
          })}
        </div>
      )}

      <TruncationNote shown={rows.length} total={fullQueue.length} noun="个目标" />
    </>
  );
}
