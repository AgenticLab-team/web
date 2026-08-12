import type { Metadata } from "next";

import { AdminNote, AdminRow, AdminTag } from "@/components/admin/ui";
import { GroupConfig } from "@/components/admin/GroupConfig";
import { SyncControls } from "@/components/admin/SyncControls";
import { relativeTime } from "@/components/forum/PostList";
import { PageHeader } from "@/components/shell/PageHeader";
import { TruncationNote } from "@/components/ui/Pagination";
import { Callout, Card, Empty, PageNote, Section } from "@/components/ui/primitives";
import { requireAdmin } from "@/lib/admin/guard";
import {
  cursors,
  listGroupsForAdmin,
  retryableJobCount,
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
  /*
   * 两个权限点任一即可进这一页。
   *
   * 页面上其实是两种东西：**群的规模数字**（多少人、多少条消息、
   * 最近有没有动静）和**群的配置**（排除同步、手动触发）。
   * 前者是审计员该看的，后者是群管理该改的。
   *
   * 只认 `group.manage` 的后果是 `group.stats.read` 永远没有用武之地 ——
   * 授出去了也进不来这一页，于是那个勾等于不存在。
   */
  const admin = await requireAdmin(["group.manage", "group.stats.read"]);
  const canManage = admin.has("group.manage");
  const canTrigger = admin.has("group.sync.trigger");

  const groups = listGroupsForAdmin();
  const sync = syncOverview();
  const upstream = upstreamStatus();
  const failed = retryableJobs(10);
  const failedTotal = retryableJobCount();
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
        <Callout tone="danger" title="数据可能没在进来">
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
        </Callout>
      )}

      {!canManage && (
        <Callout tone="neutral" title="只读">
          {/*
            * 说清楚是「你没有那个权限」，不是「这一页坏了」。
            * 一个按钮都没有的页面，不说明白的话看起来就是后者。
            */}
          你能看到群的规模和同步健康，但改不了群配置 ——
          那需要「管理群配置」这个权限。
        </Callout>
      )}

      <Section title="同步任务">
        <div className="space-y-2">
          {sync.map((s) => (
            <Card key={s.kind} className="flex flex-wrap items-center gap-2">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: VERDICT_COLORS[s.health.verdict] }}
                aria-hidden
              />
              <span className="t-body">{s.label}</span>
              <AdminTag color={VERDICT_COLORS[s.health.verdict]}>
                {VERDICT_LABELS[s.health.verdict]}
              </AdminTag>
              <span className="t-caption min-w-0 flex-1 truncate text-[var(--ink-tertiary)]">
                {s.health.message}
              </span>
              {canTrigger && <SyncControls kind={s.kind} />}
            </Card>
          ))}
        </div>
      </Section>

      {failed.length > 0 && (
        <Section
          title="失败的任务"
          action={canTrigger ? <SyncControls /> : undefined}
        >
          <div className="inset-group">
            {failed.map((job) => (
              <AdminRow key={job.id}>
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
                {canTrigger && <SyncControls retryableId={job.id} />}
              </AdminRow>
            ))}
          </div>
          <TruncationNote shown={failed.length} total={failedTotal} noun="个失败任务" />
        </Section>
      )}

      <Section title={`群（${groups.length}）`}>
        {groups.length === 0 ? (
          <Empty title="还没有接入任何群" hint="先在服务器上跑 npm run bootstrap 拉会话列表" />
        ) : (
          <div className="space-y-2.5">
            {groups.map((group) => (
              <Card as="article" key={group.convId}>
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
                        /*
                         * ─────────────────────────────────────────
                         * 这个差额是**正常的**，不再标成警告
                         * ─────────────────────────────────────────
                         *
                         * 上游那两个接口口径不同：`/conversations` 的会话计数里
                         * 含着一批 `/messages` 根本不返回的东西（撤回、系统提示之类），
                         * 而站里的归档是从 `/messages` 拉的。
                         *
                         * 实测三个群：本地条数和上游 `/messages` 的 total
                         * **一条不差**，而会话计数比它们多 4~11%。
                         *
                         * 也就是说这个差额**永远追不平**。用黄色标出来的话，
                         * 后台上就常驻一个消不掉的告警 ——
                         * 而一个永远在响的告警，会让人连真的那次也一起无视。
                         */
                        <span className="text-[var(--ink-quaternary)]">
                          {" "}
                          （上游会话计数 {group.messageCount.toLocaleString("zh-CN")}，
                          含撤回等拉不到的）
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

                  {canManage && <GroupConfig group={group} />}
                </header>
              </Card>
            ))}
          </div>
        )}
      </Section>

      {cursorRows.length > 0 && (
        <Section title="增量游标">
          <div className="inset-group">
            {cursorRows.map((c) => (
              <AdminRow key={`${c.kind}:${c.scope}`}>
                <span className="t-subhead shrink-0">{c.kind}</span>
                {c.scope && (
                  <span className="t-caption2 min-w-0 flex-1 truncate font-mono text-[var(--ink-quaternary)]">
                    {c.scope}
                  </span>
                )}
                <span className="tabular t-caption ml-auto text-[var(--ink-tertiary)]">
                  {c.lastTs > 0 ? relativeTime(c.lastTs) : "未开始"}
                </span>
              </AdminRow>
            ))}
          </div>
          <AdminNote>
            游标记录每类同步拉到哪儿了。它明显落后于当前时间，说明某一轮没跑完 ——
            而<strong>游标一旦前移，跳过的那段消息不会自己补回来</strong>，只能 resync 重建。
          </AdminNote>
        </Section>
      )}

      <PageNote>
        是否同步由上游的 bound 驱动，不手工维护 ——
        手动打开一个上游没绑定的群，同步只会一直拉不到东西。
        管理员能改的只有「排除同步」，它是唯一能压过上游的开关。
        手动触发只是<strong>排队</strong>，由后台同步进程取走：在 web 请求里直接跑的话，
        请求超时会把跑到一半的任务丢下，而游标已经动过了。
      </PageNote>
    </>
  );
}
