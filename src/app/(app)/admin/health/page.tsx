import { AlertTriangle, BellOff, CheckCircle2, XCircle } from "lucide-react";
import type { Metadata } from "next";
import type { ReactNode } from "react";

import { relativeTime } from "@/components/forum/PostList";
import { PageHeader } from "@/components/shell/PageHeader";
import { Empty, Group, Row, Section } from "@/components/ui/primitives";
import { requireAdmin } from "@/lib/admin/guard";
import { systemStatus } from "@/lib/admin/dashboard";
import { listAlerts } from "@/lib/alerts/dispatch";
import {
  DEFAULT_RULES,
  alertComponentFor,
  canDeliverViaWechat,
  componentLabel,
  formatDuration,
} from "@/lib/alerts/rules";

export const metadata: Metadata = { title: "系统健康与告警" };
export const dynamic = "force-dynamic";

/**
 * 系统健康与告警。
 *
 * 这一页要回答的不是「现在好不好」—— 那个仪表盘上就有。
 * 它要回答的是**「坏了的时候，有人会知道吗」**。
 *
 * 所以最靠前的不是组件状态，是「发出去了没有」：
 * 一个躺在库里没送达的告警，和没有告警，对当事人来说是一样的。
 */
export default async function AdminHealthPage() {
  await requireAdmin("system.dashboard");

  const status = systemStatus();
  const alerts = listAlerts(40);
  const firing = alerts.filter((a) => a.state === "firing");
  const undelivered = firing.filter((a) => a.notifyError !== null);
  const probeStale = status.staleSeconds !== null && status.staleSeconds > 900;

  return (
    <>
      <PageHeader
        title="系统健康与告警"
        subtitle={
          firing.length > 0
            ? `${firing.length} 条告警中${undelivered.length > 0 ? ` · ${undelivered.length} 条没送达` : ""}`
            : "当前没有告警"
        }
      />

      {/* 探测本身停了比某个组件挂了更危险 —— 后者会告警，前者悄无声息 */}
      {probeStale && (
        <Callout tone="danger" icon={<XCircle className="h-4 w-4 shrink-0" strokeWidth={2} />}>
          <p className="t-subhead font-medium">
            健康探测已经 {Math.round((status.staleSeconds ?? 0) / 60)} 分钟没跑了
          </p>
          <p className="t-caption mt-1 leading-relaxed">
            这一页上的所有「正常」都不可信 —— 它们只是最后一次探测留下的结果。
            先去服务器上看 <code className="font-mono">agenticlab-health.timer</code> 还活着没有。
          </p>
        </Callout>
      )}

      {undelivered.length > 0 && (
        <Callout tone="warning" icon={<BellOff className="h-4 w-4 shrink-0" strokeWidth={2} />}>
          <p className="t-subhead font-medium">{undelivered.length} 条告警没能送达</p>
          <p className="t-caption mt-1 leading-relaxed">
            告警已经记下来了，但<strong>没有任何人收到过它</strong>。
            没收到消息不代表没出事 —— 这一页是唯一还看得到它们的地方。
          </p>
          <ul className="mt-2 space-y-1">
            {undelivered.map((a) => (
              <li key={a.id} className="t-caption">
                {a.componentLabel}：{a.notifyError}
              </li>
            ))}
          </ul>
        </Callout>
      )}

      <Section title="正在告警">
        {firing.length === 0 ? (
          <Empty title="当前没有告警" hint="组件都正常，或者故障还没到报警线" />
        ) : (
          <div className="space-y-2">
            {firing.map((a) => (
              <article
                key={a.id}
                className="rounded-[var(--radius-card)] bg-[var(--surface)] p-3.5 hairline"
                style={{
                  borderLeft: `3px solid ${a.severity === "critical" ? "var(--danger)" : "var(--warning)"}`,
                }}
              >
                <p className="t-body flex flex-wrap items-center gap-1.5 font-medium">
                  {a.title}
                  <span className="t-caption2 text-[var(--ink-quaternary)]">
                    {a.severity === "critical" ? "严重" : "警告"}
                  </span>
                  <span className="tabular t-caption ml-auto text-[var(--ink-quaternary)]">
                    已持续 {formatDuration(a.lastSeenAt - a.firstSeenAt)}
                  </span>
                </p>
                {a.body && (
                  <p className="t-caption mt-1 leading-relaxed text-[var(--ink-secondary)]">
                    {a.body}
                  </p>
                )}
                <p className="t-caption2 mt-1.5 text-[var(--ink-quaternary)]">
                  {relativeTime(a.firstSeenAt)}开始 · 最后一次探到 {relativeTime(a.lastSeenAt)}
                  {a.notifiedAt
                    ? ` · 已通知（${relativeTime(a.notifiedAt)}）`
                    : " · 尚未送达任何人"}
                </p>
              </article>
            ))}
          </div>
        )}
      </Section>

      <Section title="组件">
        <Group>
          {status.components.map((c) => {
            const alertKey = alertComponentFor(c.component);
            const rule = DEFAULT_RULES[alertKey];
            return (
              <Row key={c.component}>
                {c.status === "ok" ? (
                  <CheckCircle2
                    className="h-4 w-4 shrink-0 text-[var(--success)]"
                    strokeWidth={2}
                    aria-hidden
                  />
                ) : c.status === "degraded" ? (
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
                  {componentLabel(c.component)}
                  {rule && (
                    <span className="t-caption2 ml-1.5 text-[var(--ink-quaternary)]">
                      挂 {Math.round(rule.fireAfterMs / 60_000)} 分钟报警
                    </span>
                  )}
                </span>
                <span className="t-caption max-w-[45%] truncate text-[var(--ink-tertiary)]">
                  {c.detail}
                </span>
              </Row>
            );
          })}
          {status.components.length === 0 && (
            <Row>
              <span className="t-subhead text-[var(--ink-secondary)]">还没有探测记录</span>
            </Row>
          )}
        </Group>
        <p className="t-caption mt-2 px-1 leading-relaxed text-[var(--ink-tertiary)]">
          <strong>frp 隧道</strong>和<strong>上游接口</strong>在告警上算同一件事 ——
          它们是同一次探测的两种失败归因。隧道一断，上游接口那一行就不再更新，
          单看它会一直显示「正常」。
        </p>
      </Section>

      <Section title="告警怎么发出去">
        <div className="inset-group">
          {Object.keys(DEFAULT_RULES).map((key) => (
            <div key={key} className="inset-row flex items-center gap-2 px-4 py-2.5">
              <span className="t-body min-w-0 flex-1 truncate">{componentLabel(key)}</span>
              <span className="t-caption shrink-0 text-[var(--ink-tertiary)]">
                {canDeliverViaWechat(key) ? "微信私聊站长" : "发不出去 · 靠外部监控"}
              </span>
            </div>
          ))}
        </div>
        <p className="t-caption mt-2 px-1 leading-relaxed text-[var(--ink-tertiary)]">
          微信通道本身走上游 —— 上游断了的时候，「上游断了」这条告警也发不出去。
          这不是可以绕过的缺陷，是结构性的：报信的人和出事的人是同一个。
          唯一不依赖上游的通道是 <code className="font-mono">/api/health</code>：
          关键组件挂掉时它返回 503，需要有一个<strong>站外</strong>的监控去打它。
        </p>
      </Section>

      <Section title="历史">
        {alerts.length === 0 ? (
          <Empty title="还没有告警记录" hint="这是好事，但也可能是探测没在跑 —— 看上面的组件时间" />
        ) : (
          <div className="inset-group">
            {alerts.map((a) => (
              <div key={a.id} className="inset-row flex items-center gap-2 px-4 py-2.5">
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{
                    background:
                      a.state === "firing"
                        ? a.severity === "critical"
                          ? "var(--danger)"
                          : "var(--warning)"
                        : "var(--success)",
                  }}
                  aria-hidden
                />
                <span className="t-body min-w-0 flex-1 truncate">{a.title}</span>
                <span className="tabular t-caption shrink-0 text-[var(--ink-quaternary)]">
                  {a.state === "resolved" && a.resolvedAt
                    ? `${formatDuration(a.resolvedAt - a.firstSeenAt)} · ${relativeTime(a.resolvedAt)}恢复`
                    : relativeTime(a.firstSeenAt)}
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>
    </>
  );
}

function Callout({
  tone,
  icon,
  children,
}: {
  tone: "danger" | "warning";
  icon: ReactNode;
  children: ReactNode;
}) {
  const color = tone === "danger" ? "var(--danger)" : "var(--warning)";
  return (
    <div
      className="mb-4 flex gap-2.5 rounded-[var(--radius-card)] p-4 hairline"
      style={{ background: `color-mix(in srgb, ${color} 9%, var(--surface))`, color }}
    >
      <span className="mt-0.5">{icon}</span>
      <div className="min-w-0 flex-1 text-[var(--ink-secondary)]">
        <div style={{ color }}>{children}</div>
      </div>
    </div>
  );
}
