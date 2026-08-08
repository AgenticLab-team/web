import { and, inArray, sql } from "drizzle-orm";
import Link from "next/link";

import { LeaderboardList } from "@/components/LeaderboardList";
import { PageHeader } from "@/components/shell/PageHeader";
import { Group, Row, Section, StatTile } from "@/components/ui/primitives";
import { getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { messages } from "@/lib/db/schema";
import { getLeaderboard, getMyRank } from "@/lib/queries/leaderboard";
import { visibleGroupsFor } from "@/lib/queries/visibility";
import { startOfDayMs, todayKey } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const user = await getCurrentUser();
  const groups = visibleGroupsFor(user);

  // 一个群都看不到的人（访客、以及已退出全部群的成员）看不到任何群相关内容
  if (groups.length === 0) {
    return <Landing loggedIn={Boolean(user)} />;
  }

  const convIds = groups.map((g) => g.convId);
  const board = getLeaderboard({ period: "week", convIds, limit: 8 });
  const myRank = user?.wxId ? getMyRank(user.wxId, { period: "week", convIds }) : null;

  // 统计也只覆盖可见的群 —— 全站聚合会把他看不到的群的数据算进去
  const scope = inArray(messages.convId, convIds);
  const totals = db
    .select({
      messages: sql<number>`count(*)`,
      quality: sql<number>`sum(${messages.isQuality})`,
      people: sql<number>`count(distinct ${messages.senderWxId})`,
    })
    .from(messages)
    .where(scope)
    .get();

  const todayCount = db
    .select({ n: sql<number>`count(*)` })
    .from(messages)
    .where(and(scope, sql`${messages.ts} >= ${startOfDayMs(todayKey())}`))
    .get();

  return (
    <>
      <PageHeader
        title="Agentic Lab"
        subtitle={`你在 ${groups.length} 个群 · ${totals?.people ?? 0} 位同群成员`}
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

      <Section title="你所在群的动态">
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
          只统计<strong className="font-medium">你所在的群</strong>，
          按高质量消息排名（≥15 字的文本或引用回复）。
        </p>
      </Section>

      <Section title="我在的群">
        <Group>
          {groups.map((group) => (
            <Row key={group.convId}>
              <span className="t-body min-w-0 flex-1 truncate">{group.name}</span>
              <span className="tabular t-footnote text-[var(--ink-tertiary)]">
                {group.messageCount.toLocaleString("zh-CN")}
              </span>
            </Row>
          ))}
        </Group>
      </Section>
    </>
  );
}

/**
 * 访客与无群成员看到的落地页。
 *
 * 刻意不透露任何社群结构：不给群名、不给群数量、不给成员名字与排名。
 * 群列表本身就是隐私 —— 有哪些群、群里有谁、谁最活跃，
 * 都是只有群里的人才该知道的事。
 */
function Landing({ loggedIn }: { loggedIn: boolean }) {
  return (
    <>
      <PageHeader title="Agentic Lab" subtitle="群聊之外的家" />

      <div className="animate-rise inset-group px-6 py-10 text-center">
        <p className="t-title3 mb-3">{loggedIn ? "你还不在任何已接入的群" : "这里是社群内部空间"}</p>
        <p className="t-subhead mx-auto max-w-sm leading-relaxed text-[var(--ink-secondary)]">
          {loggedIn
            ? "群成员身份是访问的前提。等你加入群并有发言记录后，下一轮同步就会恢复访问。"
            : "群聊数据、成员排名与讨论内容只对社群成员开放。用微信身份登录即可进入。"}
        </p>
        {!loggedIn && (
          <Link
            href="/login"
            className="t-body mt-7 inline-flex rounded-[var(--radius-control)] bg-[var(--accent)] px-6 py-3 font-medium text-[var(--accent-ink)] transition active:scale-[0.98]"
          >
            登录
          </Link>
        )}
      </div>
    </>
  );
}
