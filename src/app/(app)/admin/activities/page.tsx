import type { Metadata } from "next";

import { ActivityComposer, ActivityStatusActions } from "@/components/admin/ActivityComposer";
import { ApplicationReview } from "@/components/admin/ApplicationReview";
import { BulkFulfillPanel, RegistrarExport } from "@/components/admin/BulkDomainOps";
import { relativeTime } from "@/components/forum/PostList";
import { PageHeader } from "@/components/shell/PageHeader";
import { Card, Empty, PageNote, Section } from "@/components/ui/primitives";
import { domainExportCounts } from "@/lib/activities/export";
import type { ExportScope } from "@/lib/activities/export-rules";
import {
  exportPendingList,
  exportRegistrarList,
  listActivities,
  listApplications,
} from "@/lib/activities/queries";
import { listModules } from "@/lib/activities/registry";
import { requireAdmin } from "@/lib/admin/guard";

export const metadata: Metadata = { title: "活动" };
export const dynamic = "force-dynamic";

/**
 * 活动管理。
 *
 * 一屏之内要能回答三个问题：
 *   现在这个活动到哪一步了、名额还剩几个、待注册清单在哪。
 *
 * 最后那个是域名活动的实际交付物 ——
 * 管理员拿着清单去统一注册，所以要能直接复制走。
 */

const STATUS_COLORS: Record<string, string> = {
  draft: "var(--ink-tertiary)",
  open: "var(--success)",
  closed: "var(--warning)",
  reviewing: "var(--warning)",
  fulfilling: "var(--accent)",
  completed: "var(--ink-tertiary)",
  cancelled: "var(--danger)",
};

export default async function AdminActivitiesPage() {
  await requireAdmin("activity.manage");

  const activities = listActivities();
  const modules = listModules().map((m) => ({
    key: m.key,
    label: m.label,
    description: m.description,
  }));

  return (
    <>
      <PageHeader title="活动" subtitle={`${activities.length} 个活动`} />

      <Section title="新建">
        <ActivityComposer modules={modules} />
      </Section>

      {activities.length === 0 ? (
        <Empty title="还没有活动" hint="上面新建一个 —— 建出来是草稿，确认无误再开放" />
      ) : (
        activities.map((activity) => {
          const apps = listApplications({ activityId: activity.id });
          const pendingList = exportPendingList(activity.id);

          return (
            <Section key={activity.id} title={activity.title}>
              <Card className="space-y-3">
                <header className="flex flex-wrap items-center gap-1.5">
                  <span
                    className="t-caption2 rounded-[var(--radius-pill)] px-1.5 py-0.5 font-medium"
                    style={{
                      background: `color-mix(in srgb, ${STATUS_COLORS[activity.status]} 15%, transparent)`,
                      color: STATUS_COLORS[activity.status],
                    }}
                  >
                    {activity.statusLabel}
                  </span>
                  <span className="t-caption text-[var(--ink-tertiary)]">
                    {activity.moduleLabel}
                    {activity.quotaTotal !== null &&
                      ` · 名额 ${activity.quotaUsed}/${activity.quotaTotal}`}
                    {activity.applications > 0 && ` · ${activity.applications} 份申请`}
                    {activity.waitlisted > 0 && ` · ${activity.waitlisted} 人候补`}
                  </span>
                  {!activity.open && activity.openReason && (
                    <span className="t-caption2 text-[var(--ink-quaternary)]">
                      {activity.openReason}
                    </span>
                  )}
                </header>

                {/* 名额算错在限量活动里是致命事故，所以对不上要立刻看得见 */}
                {activity.quotaDrifted && (
                  <p
                    className="t-caption rounded-[var(--radius-control)] px-3 py-2"
                    style={{
                      background: "color-mix(in srgb, var(--danger) 10%, transparent)",
                      color: "var(--danger)",
                    }}
                  >
                    名额对不上账 —— 这在限量活动里是致命的，先别继续放名额。
                  </p>
                )}

                {activity.description && (
                  <p className="t-subhead text-[var(--ink-secondary)]">{activity.description}</p>
                )}

                <ActivityStatusActions id={activity.id} status={activity.status} />

                {pendingList && (
                  <details className="rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2">
                    <summary className="t-caption cursor-pointer list-none text-[var(--accent)]">
                      待注册清单（{pendingList.split("\n").length} 条，可直接复制）
                    </summary>
                    <pre className="t-caption2 mt-2 overflow-x-auto whitespace-pre font-mono text-[var(--ink-secondary)]">
                      {pendingList}
                    </pre>
                    <p className="t-caption2 mt-1.5 text-[var(--ink-tertiary)]">
                      格式：域名 · 申请人 · 申请 id。注册完之后回到下面逐条回填结果，
                      失败的会把名额还回来让候补的人补上。
                    </p>
                  </details>
                )}

                {/* 批量的去程和回程：复制列表去注册商，注册完把结果粘回来 */}
                {activity.moduleKey === "domain" && (
                  <details className="rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2">
                    <summary className="t-caption cursor-pointer list-none text-[var(--accent)]">
                      批量注册与回填
                    </summary>
                    <div className="mt-2 space-y-3">
                      <RegistrarExport
                        pending={exportRegistrarList(activity.id, "pending")}
                        all={exportRegistrarList(activity.id, "all")}
                      />
                      <DomainCsvDownload id={activity.id} counts={domainExportCounts(activity.id)} />
                      <BulkFulfillPanel activityId={activity.id} />
                    </div>
                  </details>
                )}

                {apps.length === 0 ? (
                  <p className="t-caption text-[var(--ink-tertiary)]">还没有人申请</p>
                ) : (
                  <div className="space-y-2">
                    {apps.map((app) => (
                      <div
                        key={app.id}
                        className="rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2.5"
                      >
                        <p className="t-subhead flex flex-wrap items-center gap-1.5">
                          <span className="font-mono">{app.summary}</span>
                          <span className="t-caption text-[var(--ink-tertiary)]">
                            {app.userName}
                          </span>
                          <span className="t-caption2 text-[var(--ink-quaternary)]">
                            {app.statusLabel}
                            {app.queuePosition && ` · 第 ${app.queuePosition} 位`}
                          </span>
                          <span className="t-caption2 ml-auto text-[var(--ink-quaternary)]">
                            {relativeTime(app.createdAt)}
                          </span>
                        </p>

                        {app.reviewNote && (
                          <p className="t-caption mt-0.5 text-[var(--ink-tertiary)]">
                            {app.reviewNote}
                          </p>
                        )}

                        <ApplicationReview app={app} />
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </Section>
          );
        })
      )}

      <PageNote>
        导出的表格里不含微信 ID，每次导出都会留痕。
        候补不占名额；撤回、判无效、履约失败都会把名额还回来。
      </PageNote>
    </>
  );
}

/**
 * 下载域名清单。
 *
 * 三个普通的 `<a download>`，一行客户端 JS 都不用 —— 下载本来就是
 * 浏览器自己会的事。做成按钮 + fetch + Blob 的话，要多写一份
 * 加载态、一份失败态，还会在微信 webview 里遇上 Blob 下载不了的老问题。
 *
 * 数字写在按钮上：「待注册」是 0 条的时候直接告诉他 0，
 * 比让他下一个空文件再回来问「是不是坏了」强。
 */
function DomainCsvDownload({ id, counts }: { id: string; counts: Record<ExportScope, number> }) {
  const scopes: { scope: ExportScope; label: string }[] = [
    { scope: "pending", label: "待注册" },
    { scope: "fulfilled", label: "已注册" },
    { scope: "all", label: "全部" },
  ];

  return (
    <div>
      <p className="t-caption2 text-[var(--ink-tertiary)]">
        下载表格（含申请人、状态、时间、失败原因）—— 上面那份只有域名，是给注册商粘的
      </p>
      <div className="mt-1.5 flex flex-wrap gap-2">
        {scopes.map(({ scope, label }) => (
          <a
            key={scope}
            href={`/api/admin/activities/${id}/domains?scope=${scope}`}
            download
            // 空的那一档也留着但点不动：藏起来的话人会以为功能没了
            aria-disabled={counts[scope] === 0}
            className={`t-caption rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-1.5 font-medium ${
              counts[scope] === 0
                ? "pointer-events-none text-[var(--ink-quaternary)]"
                : "text-[var(--accent)]"
            }`}
          >
            {label}（{counts[scope]}）
          </a>
        ))}
      </div>
    </div>
  );
}
