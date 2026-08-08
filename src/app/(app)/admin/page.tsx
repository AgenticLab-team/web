import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { relativeTime } from "@/components/forum/PostList";
import { PageHeader } from "@/components/shell/PageHeader";
import { Group, Row, Section, StatTile } from "@/components/ui/primitives";
import { requireAdmin } from "@/lib/admin/guard";
import {
  activityStats,
  communityScale,
  messageTrend,
  pendingWork,
  recentAuditLogs,
  systemStatus,
} from "@/lib/admin/dashboard";

export const metadata: Metadata = { title: "后台" };
export const dynamic = "force-dynamic";

const COMPONENT_LABEL: Record<string, string> = {
  upstream_api: "上游接口",
  frp_tunnel: "frp 隧道",
  db: "数据库",
  disk: "磁盘",
  mail: "邮件",
  cron: "定时任务",
};

export default async function AdminDashboard() {
  const admin = await requireAdmin();
  const pending = pendingWork();
  const activity = activityStats();
  const status = systemStatus();
  const scale = communityScale();
  const trend = messageTrend(14);
  const logs = admin.has("audit.read") ? recentAuditLogs(8) : [];

  const totalPending = pending.reports + pending.appeals + pending.anomalies;
  const unhealthy = status.components.filter((c) => c.status !== "ok");
  const maxTrend = Math.max(1, ...trend.map((d) => d.total));

  return (
    <>
      <PageHeader
        title="仪表盘"
        subtitle={
          totalPending > 0 ? `${totalPending} 件待处理` : "没有待处理事项"
        }
      />

      {/* 待办放最前面：每个数字都要能指向一个动作。
          「累计消息 41,622」看着漂亮但没人会因为它做任何事 */}
      <Section title="待处理">
        <div className="grid grid-cols-3 gap-2.5">
          <PendingTile label="举报" value={pending.reports} href="/admin/moderation" />
          <PendingTile label="申诉" value={pending.appeals} href="/admin/appeals" />
          <PendingTile label="积分异常" value={pending.anomalies} href="/admin/points" />
        </div>
      </Section>

      <Section title="系统健康">
        <Group>
          {status.components.map((component) => (
            <Row key={component.component}>
              {component.status === "ok" ? (
                <CheckCircle2
                  className="h-4 w-4 shrink-0 text-[var(--success)]"
                  strokeWidth={2}
                  aria-hidden
                />
              ) : component.status === "degraded" ? (
                <AlertTriangle
                  className="h-4 w-4 shrink-0 text-[var(--warning)]"
                  strokeWidth={2}
                  aria-hidden
                />
              ) : (
                <XCircle
                  className="h-4 w-4 shrink-0 text-[var(--danger)]"
                  strokeWidth={2}
                  aria-hidden
                />
              )}
              <span className="t-body min-w-0 flex-1 truncate">
                {COMPONENT_LABEL[component.component] ?? component.component}
              </span>
              <span className="t-caption truncate text-[var(--ink-tertiary)]">
                {component.detail}
              </span>
            </Row>
          ))}

          {status.components.length === 0 && (
            <Row>
              <span className="t-subhead text-[var(--ink-secondary)]">还没有探测记录</span>
            </Row>
          )}
        </Group>

        <div className="mt-2 space-y-1 px-1">
          {/* 探测本身停了比某个组件挂了更危险 —— 后者会告警，前者悄无声息 */}
          {status.staleSeconds !== null && status.staleSeconds > 900 && (
            <p className="t-caption text-[var(--danger)]">
              健康探测已经 {Math.round(status.staleSeconds / 60)} 分钟没跑了，
              定时任务可能挂了
            </p>
          )}
          {status.syncFailures24h > 0 && (
            <p className="t-caption text-[var(--warning)]">
              24 小时内同步失败 {status.syncFailures24h} 次
              {status.lastSync?.error && ` · 最近：${status.lastSync.error.slice(0, 60)}`}
            </p>
          )}
          {status.disk && (
            <p className="tabular t-caption text-[var(--ink-tertiary)]">
              磁盘 {status.disk.pct}% · 库 {(status.disk.dbBytes / 1048576).toFixed(1)} MB ·
              {" "}
              {relativeTime(status.disk.takenAt)}
            </p>
          )}
        </div>
      </Section>

      <Section title="今日活跃">
        <div className="grid grid-cols-3 gap-2.5">
          <StatTile label="日活" value={activity.dau} hint={`周活 ${activity.wau}`} accent />
          <StatTile
            label="今日消息"
            value={activity.messagesToday}
            hint={`高质量 ${activity.qualityRateToday}%`}
          />
          <StatTile label="打卡" value={activity.checkinsToday} hint={`发出 ${activity.pointsGrantedToday} 分`} />
        </div>
        <div className="mt-2.5 grid grid-cols-3 gap-2.5">
          <StatTile label="新绑定" value={activity.newBindings7d} hint="近 7 天" />
          <StatTile label="新帖" value={activity.postsToday} />
          <StatTile label="新回复" value={activity.repliesToday} />
        </div>
      </Section>

      <Section title="近 14 天消息量">
        <div className="inset-group p-4">
          <div className="flex h-24 items-end gap-1">
            {trend.map((day) => (
              <div
                key={day.date}
                className="group relative flex-1"
                title={`${day.date} · ${day.total} 条（高质量 ${day.quality}）`}
              >
                {/* 总量画浅色，高质量画深色叠在下面 —— 一眼看出比例 */}
                <div
                  className="w-full rounded-t-[2px] bg-[var(--fill-strong)]"
                  style={{ height: `${(day.total / maxTrend) * 96}px` }}
                />
                <div
                  className="absolute bottom-0 w-full rounded-t-[2px] bg-[var(--accent)]"
                  style={{ height: `${(day.quality / maxTrend) * 96}px` }}
                />
              </div>
            ))}
          </div>
          <div className="tabular t-caption2 mt-2 flex justify-between text-[var(--ink-quaternary)]">
            <span>{trend[0]?.date.slice(5)}</span>
            <span>{trend[trend.length - 1]?.date.slice(5)}</span>
          </div>
        </div>
      </Section>

      <Section title="社区规模">
        <Group>
          <Row>
            <span className="t-body flex-1">社群成员</span>
            <span className="tabular t-subhead">{scale.people.toLocaleString("zh-CN")}</span>
          </Row>
          <Row>
            <span className="t-body flex-1">已绑定账号</span>
            <span className="tabular t-subhead">{scale.boundUsers}</span>
          </Row>
          <Row>
            <span className="t-body flex-1">接入的群</span>
            <span className="tabular t-subhead">{scale.groups}</span>
          </Row>
          <Row>
            <span className="t-body flex-1">镜像消息</span>
            <span className="tabular t-subhead">{scale.messages.toLocaleString("zh-CN")}</span>
          </Row>
          <Row>
            <span className="t-body flex-1">论坛帖子</span>
            <span className="tabular t-subhead">{scale.posts}</span>
          </Row>
        </Group>
      </Section>

      {logs.length > 0 && (
        <Section
          title="最近的管理操作"
          action={
            <Link href="/admin/audit" className="t-footnote text-[var(--accent)]">
              全部
            </Link>
          }
        >
          <Group>
            {logs.map((log) => (
              <Row key={log.id}>
                <span className="t-caption font-mono text-[var(--ink-tertiary)]">{log.action}</span>
                <span className="t-caption min-w-0 flex-1 truncate text-[var(--ink-secondary)]">
                  {log.targetLabel ?? log.targetId ?? ""}
                </span>
                <span className="tabular t-caption shrink-0 text-[var(--ink-quaternary)]">
                  {relativeTime(log.createdAt)}
                </span>
              </Row>
            ))}
          </Group>
        </Section>
      )}
    </>
  );
}

function PendingTile({ label, value, href }: { label: string; value: number; href: string }) {
  const urgent = value > 0;
  return (
    <Link
      href={href}
      className={`rounded-[var(--radius-card)] p-4 transition active:scale-[0.98] ${
        urgent ? "bg-[var(--warning)]/12" : "bg-[var(--surface)]"
      }`}
    >
      <p
        className={`tabular t-title1 leading-none ${
          urgent ? "text-[var(--warning)]" : "text-[var(--ink-tertiary)]"
        }`}
      >
        {value}
      </p>
      <p className="t-footnote mt-2 text-[var(--ink-secondary)]">{label}</p>
    </Link>
  );
}
