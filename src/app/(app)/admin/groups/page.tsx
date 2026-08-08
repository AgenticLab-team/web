import type { Metadata } from "next";

import { GroupConfig } from "@/components/admin/GroupConfig";
import { SyncControls } from "@/components/admin/SyncControls";
import { relativeTime } from "@/components/forum/PostList";
import { PageHeader } from "@/components/shell/PageHeader";
import { Empty, Section } from "@/components/ui/primitives";
import { requireAdmin } from "@/lib/admin/guard";
import {
  cursors,
  listGroupsForAdmin,
  retryableJobs,
  syncOverview,
  upstreamStatus,
} from "@/lib/admin/groups";
import { FRESHNESS_LABELS, VERDICT_LABELS, formatSpan } from "@/lib/sync/health";

export const metadata: Metadata = { title: "群与数据源" };
export const dynamic = "force-dynamic";

/**
 * 群与数据源。
 *
 * 这一页存在的唯一理由：**发现数据没进来**。
 *
 * 上游断掉的表现是消息数不再增长 —— 而那和「今天大家没说话」
 * 在数据上长得一模一样，榜单照常显示、首页照常显示 0，
 * 没有任何地方会红。等到有人发现「我明明发了怎么没算」，
 * 往往已经过去几天。
 *
 * 所以异常判定必须相对于**每个群自己的节奏**：
 * 一天两百条的群安静半天就该查，一周三条的群安静三天很正常。
 * 用统一阈值的话，冷清的群天天报警，然后报警就会被忽略。
 */

const FRESHNESS_COLORS: Record<string, string> = {
  fresh: "var(--success)",
  quiet: "var(--ink-tertiary)",
  stale: "var(--danger)",
  unknown: "var(--warning)",
};

const VERDICT_COLORS: Record<string, string> = {
  ok: "var(--success)",
  degraded: "var(--warning)",
  down: "var(--danger)",
  never: "var(--ink-tertiary)",
};

export default async function AdminGroupsPage() {
  await requireAdmin("group.manage");

  const groups = listGroupsForAdmin();
  const sync = syncOverview();
  const upstream = upstreamStatus();
  const failed = retryableJobs(10);
  const cursorRows = cursors();

  const stale = groups.filter((g) => g.freshness.level === "stale");
  const broken = sync.filter((s) => s.health.verdict === "down");

  return (
    <>
      <PageHeader
        title="群与数据源"
        subtitle={`${upstream.syncedGroups} / ${upstream.boundGroups} 个群接入 · ${upstream.totalMessages.toLocaleString("zh-CN")} 条消息`}
      />

      {/* 结论先行：有问题的先说，没问题的一句话带过 */}
      {(stale.length > 0 || broken.length > 0) && (
        <div
          className="mb-4 rounded-[var(--radius-card)] p-4 hairline"
          style={{ background: "color-mix(in srgb, var(--danger) 9%, var(--surface))" }}
        >
          <p className="t-subhead font-medium" style={{ color: "var(--danger)" }}>
            数据可能没在进来
          </p>
          <ul className="mt-1.5 space-y-0.5">
            {broken.map((s) => (
              <li key={s.kind} className="t-caption text-[var(--ink-secondary)]">
                · {s.label}同步：{s.health.message}
              </li>
            ))}
            {stale.map((g) => (
              <li key={g.convId} className="t-caption text-[var(--ink-secondary)]">
                · {g.name}：{g.freshness.message}
              </li>
            ))}
          </ul>
          <p className="t-caption2 mt-1.5 text-[var(--ink-tertiary)]">
            先查 frp 隧道 —— 它是上游数据的唯一通道，断了之后本站的表现
            和「大家今天没说话」完全一样，不会有任何地方报错。
          </p>
        </div>
      )}

      <Section title="同步任务">
        <div className="space-y-2">
          {sync.map((s) => (
            <div
              key={s.kind}
              className="flex flex-wrap items-center gap-2 rounded-[var(--radius-card)] bg-[var(--surface)] px-4 py-3 hairline"
            >
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: VERDICT_COLORS[s.health.verdict] }}
                aria-hidden
              />
              <span className="t-body">{s.label}</span>
              <span
                className="t-caption2 rounded-[var(--radius-pill)] px-1.5 py-0.5 font-medium"
                style={{
                  background: `color-mix(in srgb, ${VERDICT_COLORS[s.health.verdict]} 15%, transparent)`,
                  color: VERDICT_COLORS[s.health.verdict],
                }}
              >
                {VERDICT_LABELS[s.health.verdict]}
              </span>
              <span className="t-caption min-w-0 flex-1 truncate text-[var(--ink-tertiary)]">
                {s.health.message}
              </span>
              <SyncControls kind={s.kind} />
            </div>
          ))}
        </div>
      </Section>

      {failed.length > 0 && (
        <Section
          title="失败的任务"
          action={<SyncControls />}
        >
          <div className="inset-group">
            {failed.map((job) => (
              <div key={job.id} className="inset-row flex items-center gap-2 px-4 py-2.5">
                <span className="t-subhead shrink-0">{job.kind}</span>
                {job.scope && (
                  <span className="t-caption2 shrink-0 font-mono text-[var(--ink-quaternary)]">
                    {job.scope}
                  </span>
                )}
                <span className="t-caption min-w-0 flex-1 truncate" style={{ color: "var(--danger)" }}>
                  {job.error ?? "无错误信息"}
                </span>
                {job.retryCount > 0 && (
                  <span className="t-caption2 shrink-0 text-[var(--ink-quaternary)]">
                    已重试 {job.retryCount} 次
                  </span>
                )}
                <span className="tabular t-caption2 shrink-0 text-[var(--ink-quaternary)]">
                  {relativeTime(job.createdAt)}
                </span>
                <SyncControls retryableId={job.id} />
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section title={`群（${groups.length}）`}>
        {groups.length === 0 ? (
          <Empty title="还没有接入任何群" hint="先在服务器上跑 npm run bootstrap 拉会话列表" />
        ) : (
          <div className="space-y-2.5">
            {groups.map((group) => (
              <article
                key={group.convId}
                className="rounded-[var(--radius-card)] bg-[var(--surface)] p-4 hairline"
              >
                <header className="flex items-start gap-3">
                  <span
                    className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                    style={{ background: FRESHNESS_COLORS[group.freshness.level] }}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <p className="t-body flex flex-wrap items-center gap-1.5">
                      <span className="truncate font-medium">{group.name}</span>
                      {!group.bound && (
                        <span className="t-caption2 text-[var(--ink-quaternary)]">上游未绑定</span>
                      )}
                      {group.syncExcluded && (
                        <span className="t-caption2 text-[var(--warning)]">已排除</span>
                      )}
                      <span
                        className="t-caption2"
                        style={{ color: FRESHNESS_COLORS[group.freshness.level] }}
                      >
                        {FRESHNESS_LABELS[group.freshness.level]}
                      </span>
                    </p>

                    <p className="tabular t-caption mt-0.5 text-[var(--ink-tertiary)]">
                      {group.liveMessages.toLocaleString("zh-CN")} 条
                      {group.liveMessages !== group.messageCount && (
                        <span style={{ color: "var(--warning)" }}>
                          {" "}
                          （缓存记的是 {group.messageCount.toLocaleString("zh-CN")}）
                        </span>
                      )}{" "}
                      · 日均 {group.dailyAverage.toFixed(1)} · {group.memberCount} 人 · 阈值{" "}
                      {group.effectiveQualityMin}
                      {group.qualityMin !== null && "（本群覆盖）"}
                      {!group.countForPoints && " · 不计分"}
                    </p>

                    <p className="t-caption2 mt-0.5 text-[var(--ink-quaternary)]">
                      {group.lastMessageAt
                        ? `最新消息 ${relativeTime(group.lastMessageAt)}`
                        : "还没有任何消息"}
                      {group.freshness.level !== "fresh" && ` —— ${group.freshness.message}`}
                      {group.freshness.level === "fresh" &&
                        group.dailyAverage > 0 &&
                        ` · 安静超过 ${formatSpan(group.freshness.toleranceMs)} 才会报警`}
                    </p>
                  </div>

                  <GroupConfig group={group} />
                </header>
              </article>
            ))}
          </div>
        )}
      </Section>

      {cursorRows.length > 0 && (
        <Section title="增量游标">
          <div className="inset-group">
            {cursorRows.map((c) => (
              <div key={`${c.kind}:${c.scope}`} className="inset-row flex items-center gap-2 px-4 py-2.5">
                <span className="t-subhead shrink-0">{c.kind}</span>
                {c.scope && (
                  <span className="t-caption2 min-w-0 flex-1 truncate font-mono text-[var(--ink-quaternary)]">
                    {c.scope}
                  </span>
                )}
                <span className="tabular t-caption ml-auto text-[var(--ink-tertiary)]">
                  {c.lastTs > 0 ? relativeTime(c.lastTs) : "未开始"}
                </span>
              </div>
            ))}
          </div>
          <p className="t-caption mt-2 px-1 leading-relaxed text-[var(--ink-tertiary)]">
            游标记录每类同步拉到哪儿了。它明显落后于当前时间，说明某一轮没跑完 ——
            而**游标一旦前移，跳过的那段消息不会自己补回来**，只能 resync 重建。
          </p>
        </Section>
      )}

      <p className="t-caption px-1 pb-4 leading-relaxed text-[var(--ink-tertiary)]">
        是否同步由上游的 bound 驱动，不手工维护 ——
        手动打开一个上游没绑定的群，同步只会一直拉不到东西。
        管理员能改的只有「排除同步」，它是唯一能压过上游的开关。
        手动触发只是**排队**，由后台同步进程取走：在 web 请求里直接跑的话，
        请求超时会把跑到一半的任务丢下，而游标已经动过了。
      </p>
    </>
  );
}
