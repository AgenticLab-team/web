import type { Metadata } from "next";

import { ApprovalDecision, DangerousSettingRequest } from "@/components/admin/ApprovalActions";
import { relativeTime } from "@/components/forum/PostList";
import { PageHeader } from "@/components/shell/PageHeader";
import { Empty, Section } from "@/components/ui/primitives";
import { APPROVAL_HANDLERS_LOADED } from "@/lib/admin/approval-handlers";
import {
  dangerousSettingOptions,
  listApprovals,
  pendingApprovalCount,
} from "@/lib/admin/approval-queries";
import { requireAdmin } from "@/lib/admin/guard";

export const metadata: Metadata = { title: "危险操作复核" };
export const dynamic = "force-dynamic";

// 确保 handler 注册表在渲染前已经填好
void APPROVAL_HANDLERS_LOADED;

/**
 * 危险操作复核。
 *
 * 这套机制的全部价值就在「**第二个人**」四个字上。
 * 一旦允许自己批自己，它就退化成一个多余的确认弹窗 ——
 * 而多余的确认弹窗只会训练人闭着眼睛点确定。
 *
 * 另一条：**只有代码里登记过的动作能被提出**。
 * 把要执行的操作序列化存起来、批准后回放，等于在数据库里开了一个
 * 延迟执行的远程调用入口 —— 谁能往表里写一行，谁就能让系统
 * 以「已被批准」的身份执行任意操作。
 */

const STATUS_COLORS: Record<string, string> = {
  pending: "var(--warning)",
  executed: "var(--success)",
  approved: "var(--accent)",
  rejected: "var(--ink-tertiary)",
  expired: "var(--ink-tertiary)",
  failed: "var(--danger)",
};

export default async function AdminApprovalsPage() {
  const admin = await requireAdmin("system.approval");

  const rows = listApprovals(40);
  const pending = pendingApprovalCount();
  const options = dangerousSettingOptions();

  return (
    <>
      <PageHeader
        title="危险操作复核"
        subtitle={pending === 0 ? "没有待复核的操作" : `${pending} 条待复核`}
      />

      <div className="mb-4 rounded-[var(--radius-card)] bg-[var(--surface)] p-4 hairline">
        <p className="t-subhead leading-relaxed">
          改错会<strong>静默影响所有人</strong>的操作走这里 —— 需要另一个人批准。
        </p>
        <p className="t-caption mt-1.5 leading-relaxed text-[var(--ink-tertiary)]">
          判断一件事该不该进这个队列，标准不是「重不重要」，
          是<strong>「改错之后多久才会有人察觉」</strong> —— 越久越危险。
          把每日积分上限设成 0，全站都拿不到分，而大家只会以为「今天没发分」。
          待批记录 24 小时后过期：一周后才执行的批准，当时的判断依据早就变了。
        </p>
      </div>

      <Section title="发起">
        <DangerousSettingRequest options={options} />
      </Section>

      <Section title="记录">
        {rows.length === 0 ? (
          <Empty title="还没有任何待复核记录" hint="这不一定是好事 —— 也可能是大家在绕过流程" />
        ) : (
          <div className="space-y-3">
            {rows.map((row) => (
              <article
                key={row.id}
                className="space-y-2.5 rounded-[var(--radius-card)] bg-[var(--surface)] p-4 hairline"
              >
                <header className="flex flex-wrap items-center gap-1.5">
                  <span className="t-body font-medium">{row.actionLabel}</span>
                  <span
                    className="t-caption2 font-medium"
                    style={{
                      color: row.expired
                        ? "var(--ink-tertiary)"
                        : (STATUS_COLORS[row.status] ?? "var(--ink-tertiary)"),
                    }}
                  >
                    {row.expired ? "已过期" : row.statusLabel}
                  </span>
                  <span className="t-caption ml-auto text-[var(--ink-quaternary)]">
                    {relativeTime(row.requestedAt)}
                  </span>
                </header>

                {/* 复核一段看不懂的 JSON 等于没复核，所以这里是一句人话 */}
                <p className="t-subhead rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2">
                  {row.describe}
                </p>

                <p className="t-caption text-[var(--ink-tertiary)]">
                  {row.requestedByName} 发起：{row.reason}
                  {row.approvedByName && ` · ${row.approvedByName} 复核`}
                  {row.approveNote && `：${row.approveNote}`}
                </p>

                {row.executeError && (
                  <p className="t-caption" style={{ color: "var(--danger)" }}>
                    执行失败：{row.executeError}
                  </p>
                )}

                {row.status === "pending" && (
                  <ApprovalDecision
                    id={row.id}
                    isRequester={row.requestedBy === admin.user.id}
                    expired={row.expired}
                    describe={row.describe}
                  />
                )}
              </article>
            ))}
          </div>
        )}
      </Section>
    </>
  );
}
