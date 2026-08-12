import type { Metadata } from "next";

import { AdminNote, AdminRow } from "@/components/admin/ui";
import { BroadcastComposer, BroadcastReview } from "@/components/admin/BroadcastComposer";
import { relativeTime } from "@/components/forum/PostList";
import { PageHeader } from "@/components/shell/PageHeader";
import { recentDigests } from "@/lib/digest/build";
import { Pagination } from "@/components/ui/Pagination";
import { Callout, Card, Empty, PageNote, Section } from "@/components/ui/primitives";
import { requireAdmin } from "@/lib/admin/guard";
import {
  deliveriesOf,
  msSinceLastSend,
  pagedBroadcasts,
  sendableGroups,
  sentToday,
} from "@/lib/broadcast/queries";
import {
  audienceSize,
  dismissedCount,
  groupNamesOf,
  roleNameOf,
  targetableGroups,
  targetableRoles,
} from "@/lib/broadcast/announce";
import { describeAudience } from "@/lib/broadcast/announce-rules";
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

export default async function AdminBroadcastPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const admin = await requireAdmin("announce.site");
  const params = await searchParams;

  const { rows, total, slice } = pagedBroadcasts({ page: params.page });
  const sendable = sendableGroups();
  const today = sentToday();
  const gap = msSinceLastSend();

  const memberCounts = new Map(
    db.select({ convId: groups.convId, n: groups.memberCount }).from(groups).all().map((g) => [g.convId, g.n]),
  );

  const gapLeft =
    gap !== null && gap < MIN_SEND_GAP_MS ? Math.ceil((MIN_SEND_GAP_MS - gap) / 60_000) : 0;

  const digests = recentDigests(4);

  return (
    <>
      <PageHeader
        title="公告与群发"
        subtitle={`今天已群发 ${today} / ${MAX_SENDS_PER_DAY} 次`}
      />

      {(today >= MAX_SENDS_PER_DAY || gapLeft > 0) && (
        <Callout
          tone="warning"
          title={
            today >= MAX_SENDS_PER_DAY
              ? `今天的群发次数已经用完（${MAX_SENDS_PER_DAY} 次）`
              : `距上次群发还不到半小时，还要等 ${gapLeft} 分钟`
          }
        >
          <p className="t-caption mt-1 leading-relaxed text-[var(--ink-secondary)]">
            这不是流程繁琐 —— 机器人已经因为高频操作被微信风控过一次（加好友那次），
            而群发比加好友显眼得多。发太勤的另一个后果是大家开始屏蔽这个群，
            那比被风控更难挽回。
          </p>
        </Callout>
      )}

      {/* 每周精选是定时任务备好的草稿 —— 摆在最前面，
          否则一个没人点开的草稿和没生成过完全一样 */}
      {digests.length > 0 && (
        <Section title="每周精选">
          <div className="inset-group">
            {digests.map((run) => (
              <AdminRow key={run.id} align="start" className="flex-col">
                <p className="t-body flex flex-wrap items-center gap-1.5">
                  <span className="tabular">{run.weekStart} 那周</span>
                  {run.broadcastId ? (
                    <span className="t-caption2" style={{ color: "var(--warning)" }}>
                      草稿已备好 · {run.itemCount} 条 · 等人复核
                    </span>
                  ) : (
                    <span className="t-caption2 text-[var(--ink-quaternary)]">未生成</span>
                  )}
                </p>
                {run.skipReason && (
                  <p className="t-caption mt-0.5 leading-relaxed text-[var(--ink-tertiary)]">
                    {run.skipReason}
                  </p>
                )}
              </AdminRow>
            ))}
          </div>
          <AdminNote>
            定时任务每周只<strong>生成草稿</strong>，不发送 ——
            一个每周自动向一千六百人广播的机器人，被风控只是时间问题，
            而且没有人会为一条没人看过的自动消息负责。
            草稿走下面同一套复核与发送流程。
          </AdminNote>
        </Section>
      )}

      <Section title="新建">
        <BroadcastComposer
          roles={targetableRoles().map((r) => ({ id: r.id, name: r.name }))}
          canWechat={admin.has("broadcast.wechat")}
          groups={sendable.map((g) => ({
            convId: g.convId,
            name: g.name,
            memberCount: memberCounts.get(g.convId) ?? 0,
          }))}
          /*
           * 站内公告能限定到的群 —— 和上面那份不是同一批。
           * 上面是「机器人发得进去的」，这份是「站里认得的」：
           * 一个机器人发不进去的群，里面的人照样在用这个站。
           */
          siteGroups={targetableGroups().map((g) => ({
            convId: g.convId,
            name: g.name ?? g.convId,
            memberCount: g.members,
          }))}
        />
      </Section>

      <Section title="记录">
        {rows.length === 0 ? (
          <Empty title="还没有发过公告" hint="上面新建一条 —— 起草之后要另一个人复核才发得出去" />
        ) : (
          <div className="space-y-3">
            {rows.map((row) => {
              const deliveries = row.channel === "wechat" ? deliveriesOf(row.id) : [];
              const failedOnes = deliveries.filter((d) => d.status === "failed");

              return (
                <Card as="article" key={row.id} className="space-y-2.5">
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
                    {/*
                      * 站内公告不说「已送达 1」—— 那个 1 是「发布成功」，
                      * 不是「有人看到了」，而它长得就像送达人数。
                      * 说的是发给谁、以及有多少人真的把它关掉了：
                      * 点了关的人一定是看见了，这是唯一诚实的那个数。
                      */}
                    {row.channel === "site" && row.status === "sent" && (
                      <> · {describeAudience(
                          roleNameOf(row.targetRoleId),
                          audienceSize(row.targetRoleId, row.targetConvIds as string[] | null),
                          groupNamesOf(row.targetConvIds as string[] | null),
                        )}
                        {`，${dismissedCount(row.id)} 人看过`}</>
                    )}
                    {row.channel === "wechat" && row.sentCount > 0 && ` · 已送达 ${row.sentCount}`}
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
                </Card>
              );
            })}
          </div>
        )}
        <Pagination
          slice={slice}
          total={total}
          noun="条公告"
          basePath="/admin/broadcast"
        />
      </Section>

      <PageNote>
        <strong>网站永远不会代用户发消息</strong> —— 只有系统与管理员的公告会发出去，
        而且每一条都要另一个人复核。起草人自己看不到「通过复核」按钮：
        自己批自己的话，这套流程只是给一个人多点了一次鼠标。
        发送逐个群进行并留出间隔，一秒钟连发十二条是最典型的风控触发姿势。
      </PageNote>
    </>
  );
}
