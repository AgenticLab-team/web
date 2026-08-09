import { Check, Dot } from "lucide-react";
import type { Metadata } from "next";

import { ApplyForm } from "@/components/activities/ApplyForm";
import { PageHeader } from "@/components/shell/PageHeader";
import { Card, Empty, Section } from "@/components/ui/primitives";
import { evaluateEligibility, type Rule } from "@/lib/activities/eligibility";
import { listActivities, listApplications } from "@/lib/activities/queries";
import { getModule } from "@/lib/activities/registry";
import { computeStatsFor } from "@/lib/activities/stats";
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
                    {activity.quotaTotal !== null && (
                      <span className="tabular">
                        名额 {activity.quotaUsed} / {activity.quotaTotal}
                      </span>
                    )}
                    {!activity.open && activity.openReason && <span>{activity.openReason}</span>}
                  </p>

                  {activity.description && (
                    <p className="t-body mt-2 whitespace-pre-wrap leading-relaxed">
                      {activity.description}
                    </p>
                  )}

                  {/* 够格的人也把条件列出来 —— 知道自己是怎么够格的，才知道要保持什么 */}
                  {eligibility && (
                    <ul className="mt-2 space-y-0.5">
                      {eligibility.outcomes.map((o, i) => (
                        <li
                          key={i}
                          className="t-caption2 flex items-center gap-1"
                          style={{
                            color: o.passed ? "var(--ink-tertiary)" : "var(--warning)",
                          }}
                        >
                          {/* 达标/未达标的记号用 lucide 线条，和全站图标同一套 —— 字符 ✓ 在各平台粗细不一 */}
                          {o.passed ? (
                            <Check className="h-3 w-3 shrink-0" strokeWidth={2.2} aria-hidden />
                          ) : (
                            <Dot className="h-3 w-3 shrink-0" strokeWidth={3} aria-hidden />
                          )}
                          {o.message}
                        </li>
                      ))}
                    </ul>
                  )}
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
