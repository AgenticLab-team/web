import type { Metadata } from "next";
import Link from "next/link";

import { LeaderboardList } from "@/components/LeaderboardList";
import { PageHeader } from "@/components/shell/PageHeader";
import { Pill, Section } from "@/components/ui/primitives";
import { getCurrentUser } from "@/lib/auth/session";
import { getLeaderboard, getMyRank, PERIODS, type Period } from "@/lib/queries/leaderboard";
import { allSyncedGroupIds, visibleGroupsFor } from "@/lib/queries/visibility";

export const metadata: Metadata = { title: "排行" };
export const dynamic = "force-dynamic";

function hrefFor(period: Period, scope?: string) {
  const params = new URLSearchParams();
  if (period !== "week") params.set("period", period);
  if (scope) params.set("scope", scope);
  const qs = params.toString();
  return qs ? `/leaderboard?${qs}` : "/leaderboard";
}

export default async function LeaderboardPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; scope?: string }>;
}) {
  const params = await searchParams;
  const user = await getCurrentUser();
  const myGroups = visibleGroupsFor(user);
  const period = (PERIODS.find((p) => p.key === params.period)?.key ?? "week") as Period;

  /*
   * 范围有三种：
   *   全站总榜  —— 对所有人开放，贡献排名是荣誉
   *   我的群    —— 只聚合自己所在的群
   *   某个群    —— 必须是自己所在的群
   * 后两种都要求登录；越权指定的范围一律退回总榜，不报错也不泄露该群存在。
   */
  const scopeParam = params.scope;
  const myGroup = myGroups.find((g) => g.convId === scopeParam);

  let convIds: string[];
  let scopeLabel: string;
  let activeScope: string | undefined;

  if (myGroup) {
    convIds = [myGroup.convId];
    scopeLabel = myGroup.name;
    activeScope = myGroup.convId;
  } else if (scopeParam === "mine" && myGroups.length > 0) {
    convIds = myGroups.map((g) => g.convId);
    scopeLabel = `你所在的 ${myGroups.length} 个群`;
    activeScope = "mine";
  } else {
    convIds = allSyncedGroupIds();
    scopeLabel = "全社区";
  }

  const entries = getLeaderboard({ period, convIds, limit: 50 });
  const myRank = user?.wxId ? getMyRank(user.wxId, { period, convIds }) : null;
  const inTop = myRank ? entries.some((e) => e.wxId === myRank.wxId) : false;

  return (
    <>
      <PageHeader title="排行" subtitle={`${scopeLabel} · 按高质量消息`} />

      <div className="mb-3 flex flex-wrap gap-1.5">
        {PERIODS.map((p) => (
          <Pill key={p.key} href={hrefFor(p.key, activeScope)} active={p.key === period}>
            {p.label}
          </Pill>
        ))}
      </div>

      {/* 分群范围只对成员出现，且只列自己所在的群 —— 群名对访客始终不可见 */}
      <div className="-mx-4 mb-6 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:-mx-6 sm:px-6">
        <span className="shrink-0">
          <Pill href={hrefFor(period)} active={!activeScope}>
            全社区
          </Pill>
        </span>
        {myGroups.length > 1 && (
          <span className="shrink-0">
            <Pill href={hrefFor(period, "mine")} active={activeScope === "mine"}>
              我的群
            </Pill>
          </span>
        )}
        {myGroups.map((g) => (
          <span key={g.convId} className="shrink-0">
            <Pill href={hrefFor(period, g.convId)} active={activeScope === g.convId}>
              {g.name}
            </Pill>
          </span>
        ))}
      </div>

      {/* 自己不在前 50 时单独把名次拎出来，否则这个人永远看不到自己 */}
      {myRank && !inTop && (
        <Section title="我的名次">
          <LeaderboardList entries={[myRank]} highlightWxId={user?.wxId} />
        </Section>
      )}

      <Section>
        <LeaderboardList entries={entries} highlightWxId={user?.wxId} showDelta={period !== "all"} />
      </Section>

      <p className="t-caption px-1 leading-relaxed text-[var(--ink-tertiary)]">
        高质量消息 = 长度 ≥ 15 字的文本或引用回复，口径与群里机器人报的排名一致。
        {period !== "all" && "箭头是相对上一个同长度周期的名次变化。"}
      </p>

      {!user && (
        <div className="inset-group mt-6 px-6 py-7 text-center">
          <p className="t-callout mb-1.5">想看自己所在群的榜单？</p>
          <Link
            href="/login"
            className="t-subhead mt-3 inline-flex rounded-[var(--radius-control)] bg-[var(--accent)] px-5 py-2.5 font-medium text-[var(--accent-ink)]"
          >
            登录
          </Link>
        </div>
      )}
    </>
  );
}
