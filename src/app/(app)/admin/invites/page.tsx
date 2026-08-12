import type { Metadata } from "next";
import Link from "next/link";

import { AdminRow } from "@/components/admin/ui";
import { InviteManager } from "@/components/admin/InviteManager";
import { relativeTime } from "@/components/forum/PostList";
import { PageHeader } from "@/components/shell/PageHeader";
import { Pagination } from "@/components/ui/Pagination";
import { Callout, Empty, Section } from "@/components/ui/primitives";
import { requireAdmin } from "@/lib/admin/guard";
import { inviteUseStats, listInvites, pagedInviteUses, pendingRewards } from "@/lib/invites/queries";

export const metadata: Metadata = { title: "邀请" };
export const dynamic = "force-dynamic";

/**
 * 邀请。
 *
 * 现阶段只有群成员能登录 —— 邀请是**为外部用户预留的通道**，
 * 表和流程先做好，开不开由功能开关决定。
 *
 * 这一页的重点是**让刷邀请看得见**：
 * 奖励延迟到被邀请人真的用起来才发，被封时回滚，
 * 而「回滚了几笔」这个数字直接摆在码上 —— 它高就说明这个码在被滥用。
 */
export default async function AdminInvitesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  await requireAdmin("invite.manage");
  const params = await searchParams;

  const invites = listInvites();
  const { rows: uses, total: useTotal, slice } = pagedInviteUses({ page: params.page });
  const pending = pendingRewards();

  // 告警数字对全表算，不能拿当前页 filter ——
  // 随翻页变化的告警数字比没有告警更糟
  const stats = inviteUseStats();

  return (
    <>
      <PageHeader
        title="邀请"
        subtitle={`${invites.length} 个码 · 已邀请 ${useTotal} 人`}
      />

      <Callout>
        <p className="t-subhead leading-relaxed">
          现阶段<strong>只有群成员能登录</strong>，邀请是为外部用户预留的通道 ——
          码和结算已经就位，开不开由功能开关决定。
        </p>
        <p className="t-caption mt-1.5 leading-relaxed text-[var(--ink-tertiary)]">
          奖励在被邀请人<strong>完成首次打卡</strong>时才发，不是注册时 ——
          注册即给的话，拉一堆僵尸号就能刷分，而拉僵尸号的成本几乎为零。
          打卡本身要求群里发言或论坛活跃达标，所以这条门槛是复用现成的反作弊。
          被邀请人被封时奖励会自动冲正：不回滚的话「刷号被抓也不亏」。
          <strong>只奖励直接邀请，没有多级</strong> —— 多级是传销的结构。
        </p>
      </Callout>

      {(stats.idle > 0 || stats.reverted > 0) && (
        <Callout
          tone="warning"
          title={
            <>
              {stats.idle > 0 && `${stats.idle} 个被邀请的人从没打过卡`}
              {stats.idle > 0 && stats.reverted > 0 && " · "}
              {stats.reverted > 0 && `${stats.reverted} 笔奖励已被回滚`}
            </>
          }
        >
          <p className="t-caption mt-1 leading-relaxed text-[var(--ink-secondary)]">
            从没打过卡的人不会产生奖励，所以这本身不是损失 ——
            但如果集中在同一个码上，那多半是有人在拉号。
          </p>
        </Callout>
      )}

      {pending.length > 0 && (
        <Callout title={`${pending.length} 笔奖励待结算`}>
          <p className="t-caption mt-1 text-[var(--ink-tertiary)]">
            被邀请人已经打过卡但奖励还没发。正常情况下打卡时就结算了 ——
            这个数长期不为零说明结算没跑，可以用下面的按钮补一次。
          </p>
        </Callout>
      )}

      <Section title="邀请码">
        <InviteManager invites={invites} />
      </Section>

      <Section title="使用记录">
        {uses.length === 0 ? (
          <Empty title="还没有人用过邀请码" hint="现阶段只有群成员能登录，这条通道要靠功能开关打开" />
        ) : (
          <div className="inset-group">
            {uses.map((use) => (
              <AdminRow key={use.id} className="flex-wrap gap-1.5">
                <Link href={`/admin/users/${use.inviterId}`} className="t-subhead">
                  {use.inviterName}
                </Link>
                <span className="t-caption text-[var(--ink-quaternary)]">邀请了</span>
                <Link href={`/admin/users/${use.invitedUserId}`} className="t-subhead">
                  {use.invitedName}
                </Link>

                <span className="t-caption2 font-mono text-[var(--ink-quaternary)]">
                  {use.code}
                </span>

                {use.revertedAt !== null ? (
                  <span className="t-caption2" style={{ color: "var(--danger)" }}>
                    已回滚：{use.revertReason}
                  </span>
                ) : use.rewardedAt !== null ? (
                  <span className="t-caption2" style={{ color: "var(--success)" }}>
                    已奖励 {use.rewardPoints} 分
                  </span>
                ) : (
                  <span className="t-caption2 text-[var(--ink-quaternary)]">
                    {use.invitedCheckedIn ? "待结算" : "对方还没打过卡"}
                  </span>
                )}

                <span className="t-caption ml-auto text-[var(--ink-quaternary)]">
                  {relativeTime(use.createdAt)}
                </span>
              </AdminRow>
            ))}
          </div>
        )}
        <Pagination
          slice={slice}
          total={useTotal}
          noun="条记录"
          basePath="/admin/invites"
        />
      </Section>
    </>
  );
}
