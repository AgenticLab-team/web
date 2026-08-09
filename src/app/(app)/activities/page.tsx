import type { Metadata } from "next";

import { ApplyForm } from "@/components/activities/ApplyForm";
import { Countdown } from "@/components/activities/Countdown";
import { EligibilityBars, QuotaBar } from "@/components/activities/EligibilityBars";
import { PageHeader } from "@/components/shell/PageHeader";
import { Card, Empty, Section } from "@/components/ui/primitives";
import { evaluateEligibility, type Rule } from "@/lib/activities/eligibility";
import { listActivities, listApplications } from "@/lib/activities/queries";
import { getModule } from "@/lib/activities/registry";
import { computeStatsFor } from "@/lib/activities/stats";
import { requireFeature } from "@/lib/flags/server";
import { getCurrentUser } from "@/lib/auth/session";

export const metadata: Metadata = { title: "活动" };
export const dynamic = "force-dynamic";

/**
 * 活动列表（用户侧）。
 *
 * 对每个人显示的都是**他自己的情况**：够不够格、差多少、
 * 已经登记了什么、现在到哪一步了。
 *
 * 不够格时把差距写出来而不是把入口藏起来 ——
 * 「还差 13 条高质量发言」是一个能去做的目标，
 * 而藏起来的话，人只会觉得这个活动跟自己无关。
 */
export default async function ActivitiesPage() {
  const user = await getCurrentUser();
  // 功能开关：关掉之后这一页 404 —— 只藏导航的话，地址栏敲一下照样进得去
  requireFeature("events", user);
  const activities = listActivities().filter(
    (a) => a.status !== "draft" && a.status !== "cancelled",
  );

  const stats = user ? computeStatsFor(user.id) : null;
  const mine = user ? listApplications({ userId: user.id }) : [];

  return (
    <>
      <PageHeader
        title="活动"
        subtitle={activities.length === 0 ? "暂时没有进行中的活动" : `${activities.length} 个活动`}
      />

      {activities.length === 0 ? (
        <Empty
          title="暂时没有活动"
          hint="活动会不定期开放 —— 平时在群里和论坛多聊聊，开放时门槛就不是问题"
        />
      ) : (
        activities.map((activity) => {
          const activityModule = getModule(activity.moduleKey);
          const existing = mine.find((m) => m.activityId === activity.id);

          const eligibility = stats
            ? evaluateEligibility((activity.eligibility as Rule | null) ?? null, stats)
            : null;

          const tlds = Array.isArray(activity.config.tlds)
            ? (activity.config.tlds as string[])
            : ["sh"];

          return (
            <Section key={activity.id} title={activity.title}>
              <div className="space-y-3">
                <Card>
                  <p className="t-caption flex flex-wrap items-center gap-1.5 text-[var(--ink-tertiary)]">
                    <span
                      className="t-caption2 rounded-[var(--radius-pill)] bg-[var(--fill)] px-1.5 py-0.5 font-medium"
                      style={activity.open ? { color: "var(--success)" } : undefined}
                    >
                      {activity.open ? "进行中" : activity.statusLabel}
                    </span>
                    {!activity.open && activity.openReason && <span>{activity.openReason}</span>}
                  </p>

                  {/*
                    * 倒计时只在真的设了截止时间时出现。
                    *
                    * 没设截止的活动挂一个「距结束 —」比不挂更糟：
                    * 它让人以为随时会结束，而实际上什么都没定。
                    */}
                  {activity.open && activity.closesAt !== null && (
                    <div className="mt-1.5">
                      <Countdown endsAt={activity.closesAt} />
                    </div>
                  )}

                  {/* 名额是「还抢不抢得到」，和下面那条「我够不够格」是两回事 */}
                  {activity.quotaTotal !== null && (
                    <QuotaBar used={activity.quotaUsed} total={activity.quotaTotal} />
                  )}

                  {activity.description && (
                    <p className="t-body mt-2 whitespace-pre-wrap leading-relaxed">
                      {activity.description}
                    </p>
                  )}

                  {/* 够格的人也把条件列出来 —— 知道自己是怎么够格的，才知道要保持什么 */}
                  {eligibility && <EligibilityBars outcomes={eligibility.outcomes} />}
                </Card>

                {!user ? (
                  <p className="t-caption px-1 text-[var(--ink-tertiary)]">登录后可以参加</p>
                ) : !activity.open && !existing ? (
                  <p className="t-caption px-1 text-[var(--ink-tertiary)]">
                    {activity.openReason ?? "现在不能报名"}
                  </p>
                ) : activityModule ? (
                  <ApplyForm
                    activityId={activity.id}
                    fields={activityModule.fields}
                    tlds={tlds}
                    eligible={eligibility?.eligible ?? false}
                    reasons={eligibility?.failures.map((f) => f.message) ?? []}
                    remaining={activity.quotaRemaining}
                    existing={
                      existing
                        ? {
                            id: existing.id,
                            summary: existing.summary,
                            statusLabel: existing.statusLabel,
                            canCancel: ["submitted", "waitlisted", "approved"].includes(
                              existing.status,
                            ),
                          }
                        : null
                    }
                  />
                ) : (
                  <p className="t-caption px-1 text-[var(--ink-tertiary)]">
                    这个活动的模块暂时不可用
                  </p>
                )}
              </div>
            </Section>
          );
        })
      )}
    </>
  );
}
