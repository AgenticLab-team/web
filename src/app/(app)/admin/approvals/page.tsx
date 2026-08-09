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

export const metadata: Metadata = { title: "危险操作留痕" };
export const dynamic = "force-dynamic";

// 确保 handler 注册表在渲染前已经填好
void APPROVAL_HANDLERS_LOADED;

/**
 * 危险操作留痕。
 *
 * 2026-08 前这里是双人复核（不能自己批自己）。站长明确要求管理操作
 * 不被复核挡住，所以现在它是**可选的**：危险配置可以直接在设置页改，
 * 想先写下来、想留一条批准记录的时候才用这里 —— 自己批自己也放行。
 * 队列和历史一条不删，事后追问「那件事是谁定的」时答案还在。
 *
 * 没松的那条：**只有代码里登记过的动作能被提出**。
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
        title="危险操作留痕"
        subtitle={pending === 0 ? "没有待处理的记录" : `${pending} 条待处理`}
      />

      <div className="mb-4 rounded-[var(--radius-card)] bg-[var(--surface)] p-4 hairline">
        <p className="t-subhead leading-relaxed">
          改错会<strong>静默影响所有人</strong>的操作可以在这里留一步痕迹 ——
          先写下来再执行，自己批自己也行（不再强制第二个人）。
        </p>
        <p className="t-caption mt-1.5 leading-relaxed text-[var(--ink-tertiary)]">
          什么样的事值得写一笔？标准不是「重不重要」，
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
          <Empty title="还没有任何记录" hint="危险配置也可以在设置页直接改 —— 这里只服务想留一步痕迹的人" />
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
