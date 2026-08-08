import { and, inArray, sql } from "drizzle-orm";
import Link from "next/link";

import { LeaderboardList } from "@/components/LeaderboardList";
import { PageHeader } from "@/components/shell/PageHeader";
import { Group, Row, Section, StatTile } from "@/components/ui/primitives";
import { getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { messages, people } from "@/lib/db/schema";
import { getLeaderboard, getMyRank } from "@/lib/queries/leaderboard";
import { allSyncedGroupIds, visibleGroupsFor } from "@/lib/queries/visibility";
import { startOfDayMs, todayKey } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const user = await getCurrentUser();

  // 总榜对所有人开放 —— 贡献排名是荣誉。
  // 但群的身份不外泄：下面只用 id 做聚合，不渲染任何群名。
  const allIds = allSyncedGroupIds();
  const board = getLeaderboard({ period: "week", convIds: allIds, limit: 8 });

  // 群列表是隐私，只给自己所在的群
  const myGroups = visibleGroupsFor(user);
  const myRank = user?.wxId ? getMyRank(user.wxId, { period: "week", convIds: allIds }) : null;

  const scope = inArray(messages.convId, allIds);
  const totals = db
    .select({
      messages: sql<number>`count(*)`,
      quality: sql<number>`sum(${messages.isQuality})`,
    })
    .from(messages)
    .where(scope)
    .get();

  const todayCount = db
    .select({ n: sql<number>`count(*)` })
    .from(messages)
    .where(and(scope, sql`${messages.ts} >= ${startOfDayMs(todayKey())}`))
    .get();

  const memberCount = db.select({ n: sql<number>`count(*)` }).from(people).get();

  return (
    <>
      <PageHeader
        title="Agentic Lab"
        subtitle={`${(memberCount?.n ?? 0).toLocaleString("zh-CN")} 位成员的 AI Agent 社区`}
        action={
          user ? null : (
            <Link
              href="/login"
              className="t-subhead shrink-0 rounded-[var(--radius-control)] bg-[var(--accent)] px-4 py-2 font-medium text-[var(--accent-ink)] transition active:scale-[0.97]"
            >
              登录
            </Link>
          )
        }
      />

      {myRank && (
        <Section>
          <div className="animate-rise grid grid-cols-3 gap-2.5">
            <StatTile label="本周排名" value={`#${myRank.rank}`} accent />
            <StatTile label="高质量发言" value={myRank.quality} hint={`共 ${myRank.messages} 条`} />
            <StatTile
              label="平均字数"
              value={Math.round(myRank.chars / Math.max(myRank.messages, 1))}
            />
          </div>
        </Section>
      )}

      <Section title="社区脉搏">
        <div className="animate-rise grid grid-cols-3 gap-2.5">
          <StatTile label="今日消息" value={todayCount?.n ?? 0} />
          <StatTile label="累计消息" value={totals?.messages ?? 0} />
          <StatTile
            label="高质量"
            value={Number(totals?.quality ?? 0)}
            hint={`占 ${Math.round(
              (Number(totals?.quality ?? 0) / Math.max(totals?.messages ?? 1, 1)) * 100,
            )}%`}
          />
        </div>
      </Section>

      <Section
        title="本周贡献榜"
        action={
          <Link href="/leaderboard" className="t-footnote text-[var(--accent)]">
            查看全部
          </Link>
        }
      >
        <LeaderboardList entries={board} highlightWxId={user?.wxId} />
        <p className="t-caption mt-2 px-1 leading-relaxed text-[var(--ink-tertiary)]">
          按<strong className="font-medium">高质量消息</strong>排名（≥15 字的文本或引用回复）。
          按总条数排会让复读机上榜。
        </p>
      </Section>

      {/* 群列表是隐私：只有自己所在的群才列出来，访客一个都看不到 */}
      {myGroups.length > 0 && (
        <Section title="我在的群">
          <Group>
            {myGroups.map((group) => (
              <Row key={group.convId}>
                <span className="t-body min-w-0 flex-1 truncate">{group.name}</span>
                <span className="tabular t-footnote text-[var(--ink-tertiary)]">
                  {group.messageCount.toLocaleString("zh-CN")}
                </span>
              </Row>
            ))}
          </Group>
        </Section>
      )}

      {!user && (
        <Section>
          <div className="inset-group px-6 py-8 text-center">
            <p className="t-callout mb-1.5">群聊内容与分群数据仅对成员开放</p>
            <p className="t-footnote mx-auto max-w-xs leading-relaxed text-[var(--ink-secondary)]">
              登录后可以看到自己所在群的动态、检索历史消息，并参与社区讨论。
            </p>
            <Link
              href="/login"
              className="t-subhead mt-5 inline-flex rounded-[var(--radius-control)] bg-[var(--accent)] px-5 py-2.5 font-medium text-[var(--accent-ink)] transition active:scale-[0.98]"
            >
              用微信身份登录
            </Link>
          </div>
        </Section>
      )}
    </>
  );
}
