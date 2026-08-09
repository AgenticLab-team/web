import type { Metadata } from "next";

import { FriendRequestQueue, StalledBindQueue } from "@/components/admin/BindQueue";
import { JoinQueue } from "@/components/admin/JoinQueue";
import { PageHeader } from "@/components/shell/PageHeader";
import { PageNote, Section } from "@/components/ui/primitives";
import { requireAdmin } from "@/lib/admin/guard";
import {
  applicantActivity,
  boundAccountOf,
  currentAcceptBudget,
  pendingFriendRequests,
  stalledBinds,
} from "@/lib/auth/bind-queue-queries";
import { recentJoinRequests } from "@/lib/join/actions";
import { judgeApplicant } from "@/lib/join/rules";

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

  /*
   * 申请人的「情况」在这一侧算 —— 提交页对所有情况只回一句一模一样的话。
   * 复用绑定队列那份活跃度查询：问题是同一个（这个人在不在我们群里）。
   */
  const joins = await recentJoinRequests();
  const joinRows = joins.map((r) => ({
    id: r.id,
    wxId: r.wxId,
    reason: r.reason,
    contact: r.contact,
    createdAt: r.createdAt,
    status: r.status,
    note: r.note,
    standing: judgeApplicant({
      groups: applicantActivity(r.wxId).groups,
      hasAccount: boundAccountOf(r.wxId) !== null,
    }),
  }));

  return (
    <>
      <PageHeader
        title="绑定审批"
        subtitle={`${joinRows.filter((r) => r.status === "pending").length} 份加入申请 · ${friends.length} 个好友申请 · ${stalled.length} 个人卡在登录上`}
      />

      {/*
        * 加入申请排在最前。
        *
        * 这三块解决的是同一个处境（有人进不来），但紧迫程度不同：
        * 申请加入的人**连门都还没摸到**，而卡住的绑定和好友申请
        * 至少已经在流程里了。
        */}
      <Section title="申请加入">
        <JoinQueue rows={joinRows} canHandle={admin.has("user.bind.approve")} />
      </Section>

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

      <PageNote>
        绑定的主通道是<strong>在群里发验证码</strong> —— 机器人加好友已经触发过微信风控，
        那条路不再当第一步。这里通过好友申请是限速的（一天有上限、两次之间要隔开），
        限制在服务端，按钮上的提示只是提示。
      </PageNote>
    </>
  );
}
