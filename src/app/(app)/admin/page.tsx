import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { relativeTime } from "@/components/forum/PostList";
import { PageHeader } from "@/components/shell/PageHeader";
import { Empty, Group, Row, Section, StatTile } from "@/components/ui/primitives";
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
        /*
         * 组件异常要比待办数字更靠前地说出来。
         * 「没有待处理事项」在同步已经停摆两小时的时候是**误导** ——
         * 队列空着可能只是因为数据根本没进来。
         */
        subtitle={
          unhealthy.length > 0
            ? `${unhealthy.length} 个组件异常${totalPending > 0 ? ` · ${totalPending} 件待处理` : ""}`
            : totalPending > 0
              ? `${totalPending} 件待处理`
              : "没有待处理事项"
        }
      />

      {/* 待办放最前面：每个数字都要能指向一个动作。
          「累计消息 41,622」看着漂亮但没人会因为它做任何事 */}
      <Section title="待处理">
        {/* 三个格子在 63rem 的内容区里会被拉成三条大横杠 ——
            给它们一个上限，剩下的宽度留白比撑满好看 */}
        <div className="grid grid-cols-3 gap-2.5 lg:max-w-2xl">
          {/* 数字是入口：有待办的染黄，点进去就是队列 */}
          <StatTile
            label="举报"
            value={pending.reports}
            href="/admin/reports"
            tone={pending.reports > 0 ? "warning" : undefined}
          />
          <StatTile
            label="申诉"
            value={pending.appeals}
            href="/admin/appeals"
            tone={pending.appeals > 0 ? "warning" : undefined}
          />
          <StatTile
            label="积分异常"
            value={pending.anomalies}
            href="/admin/points"
            tone={pending.anomalies > 0 ? "warning" : undefined}
          />
        </div>
      </Section>

      <Section title="系统健康">
        {status.components.length === 0 ? (
          <Empty title="还没有探测记录" hint="定时任务可能还没跑过 —— 查 agenticlab-health.timer" />
        ) : (
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

        </Group>
        )}

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
        {/* 宽栏（78rem）下一行摆得开 6 个 —— 拆成两行的话，
            下半行右侧是一整片空白，正是「空白区太多」的那种页面 */}
        <div className="grid grid-cols-3 gap-2.5 lg:grid-cols-6">
          <StatTile label="日活" value={activity.dau} hint={`周活 ${activity.wau}`} accent />
          <StatTile
            label="今日消息"
            value={activity.messagesToday}
            hint={`高质量 ${activity.qualityRateToday}%`}
          />
          <StatTile label="打卡" value={activity.checkinsToday} hint={`发出 ${activity.pointsGrantedToday} 分`} />
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

      {/*
        * 社区规模和最近的操作在桌面上并排。
        *
        * 两块都是「一行一个数字」的窄列表，各自单独占满 63rem 的话，
        * 每一行都是左边三个字、右边一个数字、中间一片空白 ——
        * 站长说的「空白区太多」最典型的样子。并排之后正好各占一半，
        * 而且首屏能同时看到规模和最近有人动过什么。
        */}
      <div className="lg:grid lg:grid-cols-2 lg:gap-x-6">
      <Section title="社区规模">
        <Group>
          <Row>
            <span className="t-body flex-1">社群成员</span>
            <span className="tabular t-subhead">{scale.people.toLocaleString("zh-CN")}</span>
          </Row>
          <Row>
            <span className="min-w-0 flex-1">
              <span className="t-body block">已绑定账号</span>
              {/*
                近 30 天的进出。

                光一个「123」在涨和在跌的时候长得一模一样 ——
                而这两种情况一个说明社群在长，一个说明该找人聊聊了。
                注销上线之后这件事才真正成立：在此之前人只进不出。

                两个数都是 0 时整行不显示 —— 一个常年写着「+0 −0」的
                角标，看两天就会被眼睛自动跳过。
              */}
              {(scale.joined30d > 0 || scale.left30d > 0) && (
                <span className="t-caption block text-[var(--ink-tertiary)]">
                  近 30 天
                  {scale.joined30d > 0 && (
                    <span style={{ color: "var(--success)" }}> +{scale.joined30d}</span>
                  )}
                  {scale.left30d > 0 && (
                    <span style={{ color: "var(--ink-secondary)" }}> −{scale.left30d}</span>
                  )}
                  {scale.left30d > 0 && (
                    <>
                      {" · "}
                      <Link href="/admin/users" className="text-[var(--accent)]">
                        看看他们留了什么话
                      </Link>
                    </>
                  )}
                </span>
              )}
            </span>
            <span className="tabular t-subhead shrink-0">{scale.boundUsers}</span>
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
      </div>
    </>
  );
}
