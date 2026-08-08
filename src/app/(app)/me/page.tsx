import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Avatar } from "@/components/Avatar";
import { PageHeader } from "@/components/shell/PageHeader";
import { Empty, Group, Row, Section, StatTile } from "@/components/ui/primitives";
import { getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { dailyStats, groupMembers, groups, people, roles, userRoles } from "@/lib/db/schema";
import { getMyRank } from "@/lib/queries/leaderboard";
import { shiftDateKey, todayKey } from "@/lib/time";

export const metadata: Metadata = { title: "我的" };
export const dynamic = "force-dynamic";

export default async function MePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const wxId = user.wxId;
  const profile = wxId ? db.select().from(people).where(eq(people.wxId, wxId)).get() : null;
  const name = user.siteNickname ?? user.wxNickname ?? profile?.displayName ?? "我";

  const heldRoles = db
    .select({ name: roles.name, color: roles.color, priority: roles.priority })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(userRoles.userId, user.id), isNull(userRoles.revokedAt)))
    .orderBy(desc(roles.priority))
    .all();

  const myGroups = wxId
    ? db
        .select({ name: groups.name, messages: groupMembers.messages, convId: groups.convId })
        .from(groupMembers)
        .innerJoin(groups, eq(groups.convId, groupMembers.convId))
        .where(and(eq(groupMembers.wxId, wxId), isNull(groupMembers.leftAt)))
        .orderBy(desc(groupMembers.messages))
        .all()
    : [];

  const weekRank = wxId ? getMyRank(wxId, { period: "week" }) : null;
  const today = todayKey();

  const todayStat = wxId
    ? db
        .select({
          messages: sql<number>`coalesce(sum(${dailyStats.messages}), 0)`,
          quality: sql<number>`coalesce(sum(${dailyStats.qualityMessages}), 0)`,
        })
        .from(dailyStats)
        .where(and(eq(dailyStats.wxId, wxId), eq(dailyStats.date, today)))
        .get()
    : null;

  // 近 12 周的活跃日历，用来做贡献热力条
  const since = shiftDateKey(today, -83);
  const activeDays = wxId
    ? db
        .select({ date: dailyStats.date, quality: sql<number>`sum(${dailyStats.qualityMessages})` })
        .from(dailyStats)
        .where(and(eq(dailyStats.wxId, wxId), sql`${dailyStats.date} >= ${since}`))
        .groupBy(dailyStats.date)
        .all()
    : [];
  const byDate = new Map(activeDays.map((d) => [d.date, Number(d.quality)]));

  return (
    <>
      <PageHeader title="我的" />

      <Section>
        <div className="inset-group animate-rise flex items-center gap-4 p-5">
          <Avatar wxId={wxId ?? user.id} name={name} src={user.wxAvatarUrl ?? profile?.avatarUrl} size={60} />
          <div className="min-w-0 flex-1">
            <p className="t-title3 truncate">{name}</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {heldRoles.map((role) => (
                <span
                  key={role.name}
                  className="t-caption rounded-[var(--radius-pill)] px-2 py-0.5 font-medium"
                  style={{
                    background: `color-mix(in srgb, ${role.color ?? "var(--ink)"} 14%, transparent)`,
                    color: role.color ?? "var(--ink-secondary)",
                  }}
                >
                  {role.name}
                </span>
              ))}
            </div>
          </div>
        </div>
      </Section>

      <Section title="今日">
        <div className="grid grid-cols-3 gap-2.5">
          <StatTile
            label="高质量发言"
            value={Number(todayStat?.quality ?? 0)}
            hint={`共 ${Number(todayStat?.messages ?? 0)} 条`}
            accent
          />
          <StatTile label="等级" value={`L${user.level}`} hint={`${user.points} 积分`} />
          <StatTile
            label="连胜"
            value={user.streakCurrent}
            hint={user.streakBest ? `最长 ${user.streakBest} 天` : undefined}
          />
        </div>
      </Section>

      <Section title="近 12 周">
        <div className="inset-group p-4">
          <ContributionGrid today={today} byDate={byDate} />
        </div>
      </Section>

      {weekRank && (
        <Section title="本周">
          <Group>
            <Row href="/leaderboard">
              <span className="t-body flex-1">贡献榜名次</span>
              <span className="tabular t-headline text-[var(--accent)]">#{weekRank.rank}</span>
            </Row>
          </Group>
        </Section>
      )}

      <Section title={`我在 ${myGroups.length} 个群`}>
        {myGroups.length === 0 ? (
          <Empty title="还没有群成员记录" hint="下一轮成员同步后会出现" />
        ) : (
          <Group>
            {myGroups.map((g) => (
              <Row key={g.convId}>
                <span className="t-body min-w-0 flex-1 truncate">{g.name}</span>
                <span className="tabular t-footnote text-[var(--ink-tertiary)]">
                  {g.messages} 条
                </span>
              </Row>
            ))}
          </Group>
        )}
      </Section>

      <Section title="账号">
        <Group>
          <Row>
            <span className="t-body flex-1">微信 ID</span>
            <span className="t-footnote font-mono text-[var(--ink-tertiary)]">{wxId}</span>
          </Row>
          <Row>
            <span className="t-body flex-1">登录方式</span>
            <span className="t-footnote text-[var(--ink-tertiary)]">微信验证码</span>
          </Row>
        </Group>
        <p className="t-caption mt-2 px-1 text-[var(--ink-tertiary)]">
          Passkey 一键登录即将上线，之后不必每次都回微信取验证码。
        </p>
      </Section>

      <Section>
        <Group>
          <Link
            href="/api/auth/logout"
            className="inset-row flex items-center justify-center px-4 py-3 transition-colors hover:bg-[var(--fill)]"
          >
            <span className="t-body text-[var(--danger)]">退出登录</span>
          </Link>
        </Group>
      </Section>
    </>
  );
}

/**
 * 贡献热力格。GitHub 那种，但按东八区切日、按高质量消息着色。
 * 12 周 × 7 天，最后一列是本周。
 */
function ContributionGrid({ today, byDate }: { today: string; byDate: Map<string, number> }) {
  const weeks: { date: string; value: number }[][] = [];
  // 从 83 天前开始，对齐到周一
  const start = shiftDateKey(today, -83);
  const startDow = (new Date(`${start}T00:00:00Z`).getUTCDay() + 6) % 7;

  let cursor = shiftDateKey(start, -startDow);
  for (let w = 0; w < 12; w++) {
    const week: { date: string; value: number }[] = [];
    for (let d = 0; d < 7; d++) {
      week.push({ date: cursor, value: byDate.get(cursor) ?? 0 });
      cursor = shiftDateKey(cursor, 1);
    }
    weeks.push(week);
  }

  const max = Math.max(1, ...byDate.values());

  return (
    <div className="flex gap-[3px]" role="img" aria-label="近 12 周高质量发言热力图">
      {weeks.map((week, i) => (
        <div key={i} className="flex flex-1 flex-col gap-[3px]">
          {week.map((day) => {
            const future = day.date > today;
            const intensity = day.value === 0 ? 0 : 0.2 + 0.8 * Math.min(1, day.value / max);
            return (
              <div
                key={day.date}
                title={`${day.date} · ${day.value} 条高质量`}
                className="aspect-square rounded-[2px]"
                style={{
                  background: future
                    ? "transparent"
                    : day.value === 0
                      ? "var(--fill)"
                      : `color-mix(in srgb, var(--accent) ${Math.round(intensity * 100)}%, transparent)`,
                }}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}
