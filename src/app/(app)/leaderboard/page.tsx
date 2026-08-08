import type { Metadata } from "next";

import { LeaderboardList } from "@/components/LeaderboardList";
import { PageHeader } from "@/components/shell/PageHeader";
import { Pill, Section } from "@/components/ui/primitives";
import { getCurrentUser } from "@/lib/auth/session";
import {
  getLeaderboard,
  getMyRank,
  PERIODS,
  syncedGroups,
  type Period,
} from "@/lib/queries/leaderboard";

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
  const period = (PERIODS.find((p) => p.key === params.period)?.key ?? "week") as Period;
  const groups = syncedGroups();
  const convId = groups.find((g) => g.convId === params.group)?.convId;

  const user = await getCurrentUser();
  const entries = getLeaderboard({ period, convId, limit: 50 });
  const myRank = user?.wxId ? getMyRank(user.wxId, { period, convId }) : null;
  const inTop = myRank ? entries.some((e) => e.wxId === myRank.wxId) : false;

  const groupName = convId ? groups.find((g) => g.convId === convId)?.name : null;

  return (
    <>
      <PageHeader
        title="排行"
        subtitle={groupName ? `${groupName} · 按高质量消息` : "全部群 · 按高质量消息"}
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
          全部群
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
        高质量消息 = 长度 ≥ 15 字的文本或引用回复。这个口径与群里机器人报的排名一致，
        随时可用 <code className="font-mono">npm run calibrate</code> 复验。
        {period !== "all" && "箭头是相对上一个同长度周期的名次变化。"}
      </p>
    </>
  );
}
