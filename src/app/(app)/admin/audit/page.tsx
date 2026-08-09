import type { Metadata } from "next";

import { relativeTime } from "@/components/forum/PostList";
import { PageHeader } from "@/components/shell/PageHeader";
import { Pagination } from "@/components/ui/Pagination";
import { Empty, PageNote, Pill, PillRow } from "@/components/ui/primitives";
import { requireAdmin } from "@/lib/admin/guard";
import { auditActionFacets, queryAuditLogs } from "@/lib/admin/audit-query";

export const metadata: Metadata = { title: "审计日志" };
export const dynamic = "force-dynamic";

const DANGER_LABEL = ["普通", "敏感", "危险", "极危"];
const DANGER_COLOR = [
  "var(--ink-tertiary)",
  "var(--ink-secondary)",
  "var(--warning)",
  "var(--danger)",
];

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; danger?: string; days?: string; page?: string }>;
}) {
  await requireAdmin("audit.read");
  const params = await searchParams;

  const minDanger = params.danger ? Number(params.danger) : undefined;
  const days = params.days ? Number(params.days) : 30;

  const { entries, total, slice } = queryAuditLogs({
    action: params.action,
    minDanger: Number.isFinite(minDanger) ? minDanger : undefined,
    days: Number.isFinite(days) ? days : 30,
    page: params.page,
  });
  const facets = auditActionFacets();

  // 筛选链接不带 page —— 换筛选后原页码大概率越界
  const href = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams();
    const merged = { action: params.action, danger: params.danger, days: params.days, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) next.set(k, v);
    const qs = next.toString();
    return qs ? `/admin/audit?${qs}` : "/admin/audit";
  };

  return (
    <>
      <PageHeader title="审计日志" subtitle={`${total} 条记录`} />

      <PillRow wrap>
        {[
          { value: undefined, label: "全部等级" },
          { value: "2", label: "危险及以上" },
          { value: "3", label: "仅极危" },
        ].map((option) => (
          <Pill
            key={option.label}
            href={href({ danger: option.value })}
            active={params.danger === option.value}
          >
            {option.label}
          </Pill>
        ))}
        {[
          { value: "7", label: "7 天" },
          { value: "30", label: "30 天" },
          { value: "3650", label: "全部时间" },
        ].map((option) => (
          <Pill
            key={option.value}
            href={href({ days: option.value })}
            active={(params.days ?? "30") === option.value}
          >
            {option.label}
          </Pill>
        ))}
      </PillRow>

      {facets.length > 0 && (
        <PillRow>
          <Pill href={href({ action: undefined })} active={!params.action}>
            全部动作
          </Pill>
          {facets.slice(0, 12).map((facet) => (
            <Pill
              key={facet.action}
              href={href({ action: facet.action })}
              active={params.action === facet.action}
            >
              {facet.label} {facet.count}
            </Pill>
          ))}
        </PillRow>
      )}

      {entries.length === 0 ? (
        <Empty title="没有匹配的记录" hint="换个筛选条件试试" />
      ) : (
        <div className="inset-group">
          {entries.map((entry) => (
            <details key={entry.id} className="inset-row">
              <summary className="flex cursor-pointer list-none items-center gap-2.5 px-4 py-3 transition-colors hover:bg-[var(--fill)]">
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: DANGER_COLOR[entry.dangerLevel] ?? DANGER_COLOR[0] }}
                  title={DANGER_LABEL[entry.dangerLevel]}
                  aria-label={DANGER_LABEL[entry.dangerLevel]}
                />
                <span className="min-w-0 flex-1">
                  <span className="t-subhead block truncate">
                    <span className="font-medium">{entry.actorName}</span>
                    {" · "}
                    {entry.actionLabel}
                    {entry.targetLabel && (
                      <span className="text-[var(--ink-secondary)]"> · {entry.targetLabel}</span>
                    )}
                  </span>
                  {entry.reason && (
                    <span className="t-caption block truncate text-[var(--ink-tertiary)]">
                      {entry.reason}
                    </span>
                  )}
                </span>
                <span className="tabular t-caption shrink-0 text-[var(--ink-quaternary)]">
                  {relativeTime(entry.createdAt)}
                </span>
              </summary>

              {/* 变更前后快照 —— 出问题时唯一能复原真相的东西 */}
              <div className="space-y-2 border-t border-[var(--separator)] bg-[var(--surface-sunken)] px-4 py-3">
                <dl className="tabular t-caption grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1 text-[var(--ink-secondary)]">
                  <dt className="text-[var(--ink-tertiary)]">动作</dt>
                  <dd className="font-mono">{entry.action}</dd>
                  <dt className="text-[var(--ink-tertiary)]">时间</dt>
                  <dd>{new Date(entry.createdAt).toLocaleString("zh-CN", { hour12: false })}</dd>
                  {entry.targetId && (
                    <>
                      <dt className="text-[var(--ink-tertiary)]">对象</dt>
                      <dd className="font-mono break-all">
                        {entry.targetType}/{entry.targetId}
                      </dd>
                    </>
                  )}
                  {entry.actorIp && (
                    <>
                      <dt className="text-[var(--ink-tertiary)]">来源 IP</dt>
                      <dd className="font-mono">{entry.actorIp}</dd>
                    </>
                  )}
                </dl>

                {Boolean(entry.before ?? entry.after) && (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <SnapshotBlock label="变更前" value={entry.before} tone="danger" />
                    <SnapshotBlock label="变更后" value={entry.after} tone="success" />
                  </div>
                )}
              </div>
            </details>
          ))}
        </div>
      )}

      <Pagination
        slice={slice}
        total={total}
        noun="条记录"
        basePath="/admin/audit"
        params={{ action: params.action, danger: params.danger, days: params.days }}
      />

      <PageNote>
        审计日志<strong className="font-medium">只增不改不删</strong>，
        系统里没有任何删除它的接口 —— 包括站长。
      </PageNote>
    </>
  );
}

function SnapshotBlock({
  label,
  value,
  tone,
}: {
  label: string;
  value: unknown;
  tone: "danger" | "success";
}) {
  if (value === null || value === undefined) return null;
  return (
    <div>
      <p className="t-caption2 mb-1 text-[var(--ink-tertiary)]">{label}</p>
      <pre
        className="t-caption overflow-x-auto rounded-[var(--radius-control)] p-2 font-mono"
        style={{
          background:
            tone === "danger"
              ? "color-mix(in srgb, var(--danger) 8%, transparent)"
              : "color-mix(in srgb, var(--success) 8%, transparent)",
        }}
      >
        {String(JSON.stringify(value, null, 2))}
      </pre>
    </div>
  );
}
