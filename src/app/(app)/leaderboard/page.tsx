import type { Metadata } from "next";
import Link from "next/link";

import { LeaderboardList } from "@/components/LeaderboardList";
import { PageHeader } from "@/components/shell/PageHeader";
import { Pill, Section } from "@/components/ui/primitives";
import { getCurrentUser } from "@/lib/auth/session";
import { getLeaderboard, getMyRank, PERIODS, type Period } from "@/lib/queries/leaderboard";
import { visibleGroupsFor } from "@/lib/queries/visibility";

export const metadata: Metadata = { title: "排行" };
export const dynamic = "force-dynamic";

function hrefFor(period: Period, convId?: string) {
  const params = new URLSearchParams();
  if (period !== "week") params.set("period", period);
  if (convId) params.set("group", convId);
  const qs = params.toString();
  return qs ? `/leaderboard?${qs}` : "/leaderboard";
}

export default async function LeaderboardPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; group?: string }>;
}) {
  const params = await searchParams;
  const user = await getCurrentUser();
  const groups = visibleGroupsFor(user);

  if (groups.length === 0) {
    return (
      <>
        <PageHeader title="排行" />
        <div className="animate-rise inset-group px-6 py-10 text-center">
          <p className="t-callout text-[var(--ink-secondary)]">排行榜只对社群成员开放</p>
          <Link
            href="/login"
            className="t-subhead mt-5 inline-flex rounded-[var(--radius-control)] bg-[var(--accent)] px-5 py-2.5 font-medium text-[var(--accent-ink)]"
          >
            登录
          </Link>
        </div>
      </>
    );
  }

  const convIds = groups.map((g) => g.convId);
  const period = (PERIODS.find((p) => p.key === params.period)?.key ?? "week") as Period;
  // 只认可见范围内的群；传了别的群等于没传，不报错也不泄露该群存在
  const convId = groups.find((g) => g.convId === params.group)?.convId;

  const entries = getLeaderboard({ period, convId, convIds, limit: 50 });
  const myRank = user?.wxId ? getMyRank(user.wxId, { period, convId, convIds }) : null;
  const inTop = myRank ? entries.some((e) => e.wxId === myRank.wxId) : false;
  const groupName = convId ? groups.find((g) => g.convId === convId)?.name : null;

  return (
    <>
      <PageHeader
        title="排行"
        subtitle={groupName ? `${groupName} · 按高质量消息` : `你所在的 ${groups.length} 个群`}
      />

      <div className="mb-4 flex flex-wrap gap-1.5">
        {PERIODS.map((p) => (
          <Pill key={p.key} href={hrefFor(p.key, convId)} active={p.key === period}>
            {p.label}
          </Pill>
        ))}
      </div>

      <div className="-mx-4 mb-6 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:-mx-6 sm:px-6">
        <Pill href={hrefFor(period)} active={!convId}>
          我的全部群
        </Pill>
        {groups.map((g) => (
          <span key={g.convId} className="shrink-0">
            <Pill href={hrefFor(period, g.convId)} active={convId === g.convId}>
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
        只统计你所在的群。高质量消息 = 长度 ≥ 15 字的文本或引用回复，
        口径与群里机器人报的排名一致。
        {period !== "all" && "箭头是相对上一个同长度周期的名次变化。"}
      </p>
    </>
  );
}
