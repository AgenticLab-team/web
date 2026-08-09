import type { Metadata } from "next";

import { FriendRequestQueue, StalledBindQueue } from "@/components/admin/BindQueue";
import { PageHeader } from "@/components/shell/PageHeader";
import { Section } from "@/components/ui/primitives";
import { requireAdmin } from "@/lib/admin/guard";
import {
  currentAcceptBudget,
  pendingFriendRequests,
  stalledBinds,
} from "@/lib/auth/bind-queue-queries";

export const metadata: Metadata = { title: "绑定审批" };
export const dynamic = "force-dynamic";

/**
 * 绑定审批队列。
 *
 * ─────────────────────────────────────────
 * 这一页只服务一个处境
 * ─────────────────────────────────────────
 *
 * 「有人进不来，我要不要放他进来」。
 *
 * 而放不放的依据只有一条：**他是不是真的在我们群里**。
 * 整站的入口规则就这一条，平时靠验证码自动完成 ——
 * 码是在群里发的，能发出来就说明人在群里。
 *
 * 人工审批是绕过那个证明的一条路，所以两个动作都自己把证明补了回来：
 * 通过好友申请前先算活跃度并显示出来；手动绑定则硬性要求那个微信号
 * 在同步的群里，服务端拒绝，没有例外。
 */
export default async function AdminBindsPage() {
  const admin = await requireAdmin("user.bind.approve");

  const [{ rows: friends, error }, budget] = await Promise.all([
    pendingFriendRequests(),
    Promise.resolve(currentAcceptBudget()),
  ]);
  const stalled = stalledBinds();

  return (
    <>
      <PageHeader
        title="绑定审批"
        subtitle={`${friends.length} 个好友申请 · ${stalled.length} 个人卡在登录上`}
      />

      <Section title="卡住的绑定">
        <StalledBindQueue
          rows={stalled.map((s) => ({
            ip: s.ip,
            codes: s.codes,
            firstAt: s.firstAt,
            lastAt: s.lastAt,
            latestCodeId: s.latestCodeId,
            latestCode: s.latestCode,
            expired: s.expired,
          }))}
          canBind={admin.has("user.bind.manual")}
        />
      </Section>

      <Section title="好友申请">
        <FriendRequestQueue
          rows={friends.map((r) => ({
            wxId: r.wxId,
            nickname: r.nickname,
            avatarUrl: r.avatarUrl,
            requestedAt: r.requestedAt,
            note: r.note,
            verdict: r.verdict,
            boundUserId: r.boundUserId,
          }))}
          upstreamError={error}
          budgetReason={budget.reason}
          canAccept={admin.has("user.bind.approve")}
        />
      </Section>

      <p className="t-caption px-1 pb-4 leading-relaxed text-[var(--ink-tertiary)]">
        绑定的主通道是<strong>在群里发验证码</strong> —— 机器人加好友已经触发过微信风控，
        那条路不再当第一步。通过好友申请<strong>不设服务端限制</strong>（站长指令），
        上面那句「今天已经通过几个」是仅有的提醒 —— 点之前看一眼它。
      </p>
    </>
  );
}
