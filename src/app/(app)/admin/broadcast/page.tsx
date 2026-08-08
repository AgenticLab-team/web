import type { Metadata } from "next";

import { BroadcastComposer, BroadcastReview } from "@/components/admin/BroadcastComposer";
import { relativeTime } from "@/components/forum/PostList";
import { PageHeader } from "@/components/shell/PageHeader";
import { Empty, Section } from "@/components/ui/primitives";
import { requireAdmin } from "@/lib/admin/guard";
import {
  deliveriesOf,
  listBroadcasts,
  msSinceLastSend,
  sendableGroups,
  sentToday,
} from "@/lib/broadcast/queries";
import { MAX_SENDS_PER_DAY, MIN_SEND_GAP_MS, channelLabel } from "@/lib/broadcast/rules";
import { db } from "@/lib/db";
import { groups } from "@/lib/db/schema";

export const metadata: Metadata = { title: "公告与群发" };
export const dynamic = "force-dynamic";

/**
 * 公告与群发。
 *
 * 全站唯一会**主动向一千六百人发消息**的功能，
 * 也是唯一一个做错之后没法靠改数据库挽回的 —— 消息已经响过了。
 *
 * 所以这一页比别处都啰嗦：每一步都写清楚代价，
 * 每一个不可逆的动作前都多一道人。
 */

const STATUS_COLORS: Record<string, string> = {
  pending: "var(--warning)",
  approved: "var(--accent)",
  sending: "var(--warning)",
  sent: "var(--success)",
  failed: "var(--danger)",
  rejected: "var(--ink-tertiary)",
  canceled: "var(--ink-tertiary)",
};

export default async function AdminBroadcastPage() {
  const admin = await requireAdmin("announce.site");

  const rows = listBroadcasts({ limit: 30 });
  const sendable = sendableGroups();
  const today = sentToday();
  const gap = msSinceLastSend();

  const memberCounts = new Map(
    db.select({ convId: groups.convId, n: groups.memberCount }).from(groups).all().map((g) => [g.convId, g.n]),
  );

  const gapLeft =
    gap !== null && gap < MIN_SEND_GAP_MS ? Math.ceil((MIN_SEND_GAP_MS - gap) / 60_000) : 0;

  return (
    <>
      <PageHeader
        title="公告与群发"
        subtitle={`今天已群发 ${today} / ${MAX_SENDS_PER_DAY} 次`}
      />

      {(today >= MAX_SENDS_PER_DAY || gapLeft > 0) && (
        <div
          className="mb-4 rounded-[var(--radius-card)] p-4 hairline"
          style={{ background: "color-mix(in srgb, var(--warning) 9%, var(--surface))" }}
        >
          <p className="t-subhead font-medium" style={{ color: "var(--warning)" }}>
            {today >= MAX_SENDS_PER_DAY
              ? `今天的群发次数已经用完（${MAX_SENDS_PER_DAY} 次）`
              : `距上次群发还不到半小时，还要等 ${gapLeft} 分钟`}
          </p>
          <p className="t-caption mt-1 leading-relaxed text-[var(--ink-secondary)]">
            这不是流程繁琐 —— 机器人已经因为高频操作被微信风控过一次（加好友那次），
            而群发比加好友显眼得多。发太勤的另一个后果是大家开始屏蔽这个群，
            那比被风控更难挽回。
          </p>
        </div>
      )}

      <Section title="新建">
        <BroadcastComposer
          canWechat={admin.has("broadcast.wechat")}
          groups={sendable.map((g) => ({
            convId: g.convId,
            name: g.name,
            memberCount: memberCounts.get(g.convId) ?? 0,
          }))}
        />
      </Section>

      <Section title="记录">
        {rows.length === 0 ? (
          <Empty title="还没有任何公告" />
        ) : (
          <div className="space-y-3">
            {rows.map((row) => {
              const deliveries = row.channel === "wechat" ? deliveriesOf(row.id) : [];
              const failedOnes = deliveries.filter((d) => d.status === "failed");

              return (
                <article
                  key={row.id}
                  className="space-y-2.5 rounded-[var(--radius-card)] bg-[var(--surface)] p-4 hairline"
                >
                  <header className="flex flex-wrap items-center gap-1.5">
                    <span className="t-caption2 rounded-[var(--radius-pill)] bg-[var(--fill)] px-1.5 py-0.5 font-medium text-[var(--ink-secondary)]">
                      {channelLabel(row.channel)}
                    </span>
                    <span
                      className="t-caption2 font-medium"
                      style={{ color: STATUS_COLORS[row.status] ?? "var(--ink-tertiary)" }}
                    >
                      {row.statusLabel}
                    </span>
                    {row.title && <span className="t-body truncate">{row.title}</span>}
                    <span className="t-caption ml-auto text-[var(--ink-quaternary)]">
                      {relativeTime(row.createdAt)}
                    </span>
                  </header>

                  <p className="t-subhead whitespace-pre-wrap rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 text-[var(--ink-secondary)]">
                    {row.content}
                  </p>

                  <p className="t-caption text-[var(--ink-tertiary)]">
                    {row.createdByName} 起草
                    {row.approvedByName && ` · ${row.approvedByName} 复核`}
                    {row.approveNote && `：${row.approveNote}`}
                    {row.channel === "wechat" && ` · ${row.targetCount} 个群`}
                    {row.sentCount > 0 && ` · 已送达 ${row.sentCount}`}
                    {row.failedCount > 0 && (
                      <span style={{ color: "var(--danger)" }}> · 失败 {row.failedCount}</span>
                    )}
                  </p>

                  {/* 失败的群要单独列出来。汇总成一个数字的话，
                      「哪三个群没收到」永远没人知道 */}
                  {failedOnes.length > 0 && (
                    <ul className="space-y-0.5">
                      {failedOnes.map((d) => (
                        <li key={d.id} className="t-caption2 text-[var(--ink-tertiary)]">
                          · {d.convName ?? d.convId}：{d.error}
                        </li>
                      ))}
                    </ul>
                  )}

                  <BroadcastReview
                    id={row.id}
                    isAuthor={row.createdBy === admin.user.id}
                    status={row.status}
                    contentDrifted={row.contentDrifted}
                  />
                </article>
              );
            })}
          </div>
        )}
      </Section>

      <p className="t-caption px-1 pb-4 leading-relaxed text-[var(--ink-tertiary)]">
        <strong>网站永远不会代用户发消息</strong> —— 只有系统与管理员的公告会发出去，
        而且每一条都要另一个人复核。起草人自己看不到「通过复核」按钮：
        自己批自己的话，这套流程只是给一个人多点了一次鼠标。
        发送逐个群进行并留出间隔，一秒钟连发十二条是最典型的风控触发姿势。
      </p>
    </>
  );
}
