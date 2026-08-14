import { and, inArray, sql } from "drizzle-orm";
import { connectionOf } from "@/lib/github/link";
import { githubEnabled } from "@/lib/github/secret";
import Link from "next/link";

import { LeaderboardList } from "@/components/LeaderboardList";
import { DigestCard } from "@/components/home/DigestCard";
import { HomeNudge } from "@/components/home/HomeNudge";
import { CheckinCard } from "@/components/points/CheckinCard";
import { PageHeader } from "@/components/shell/PageHeader";
import { Empty, EmptyAction, Group, Row, Section, StatTile } from "@/components/ui/primitives";
import { passkeyNudgeFor } from "@/lib/auth/passkey-nudge";
import { configProblem } from "@/lib/notifications/webpush";
import { getCurrentUser, getRealUser } from "@/lib/auth/session";
import { privacyOf } from "@/lib/privacy/queries";
import { db } from "@/lib/db";
import { messages, people } from "@/lib/db/schema";
import { checkinStatus } from "@/lib/points/checkin";
import type { CheckinPath } from "@/lib/points/rules";
import { buildDigest } from "@/lib/queries/digest";
import { getLeaderboard, getMyRank } from "@/lib/queries/leaderboard";
import { allSyncedGroupIds, visibleGroupIds, visibleGroupsFor } from "@/lib/queries/visibility";
import { startOfDayMs, todayKey } from "@/lib/time";

export const dynamic = "force-dynamic";

/**
 * 首页。
 *
 * 排布顺序回答的是「**我为什么明天还要打开它**」：
 *
 *   1. 你不在的时候发生了什么 —— 回来的理由，必须在最前面
 *   2. 今天要做什么才能打卡   —— 一个当天能完成的小目标
 *   3. 你现在处在什么位置     —— 排名与数据
 *   4. 社区整体              —— 榜单与脉搏
 *
 * 把打卡放第一位是很自然的想法，但那是**已经来了之后**做的事，
 * 构不成回来的理由。
 *
 * 桌面端拆成两栏：左边是「和我有关的」，右边是「社区」。
 * 单栏拉到 1400px 宽的屏幕上，一屏只能放下两张卡片，
 * 剩下的全是空白 —— 那不是留白，是没排版。
 */
export default async function HomePage() {
  const user = await getCurrentUser();

  /*
   * 自己藏没藏 —— 只是为了在自己那一行上标一句「仅自己可见」。
   *
   * 藏起来的人榜上**还看得到自己**（排除名单里没有自己）。
   * 不标的话他看到的榜和没藏时一模一样，也就没有任何办法
   * 确认那个开关生效了 —— 而只能靠相信的隐私开关跟没有是一样的。
   */
  const meHidden = user ? privacyOf(user.id).hideFromLeaderboard : false;

  // 总榜对所有人开放 —— 贡献排名是荣誉。
  // 但群的身份不外泄：下面只用 id 做聚合，不渲染任何群名。
  const allIds = allSyncedGroupIds();
  const board = getLeaderboard({ period: "week", convIds: allIds, limit: 8, viewer: user });

  // 群列表是隐私，只给自己所在的群
  const myGroups = visibleGroupsFor(user);
  const myRank = getMyRank(user, { period: "week", convIds: allIds });

  const checkin = user ? checkinStatus(user) : null;
  const digest = buildDigest(user, user ? visibleGroupIds(user) : allIds);

  /*
   * ─────────────────────────────────────────
   * 「加个 Passkey 吧」
   * ─────────────────────────────────────────
   *
   * **只对本人**，所以走 getRealUser() 而不是上面那个 user ——
   * 管理员预览别人时 user 是被预览的那个人，那张卡片上的
   * 「不用了」会写到别人的账号上，而他本人从来没看见过这张卡片。
   *
   * 摆在首页而不是 /me：这是唯一一个每个人每次都会经过的页面，
   * 而 /me 是要专门去点的。它一生最多出现两次（一次，
   * 「以后再说」两周后再一次），绑上或者说了「不用了」就再也不出现，
   * 所以它占得起左栏最上面这个位置。
   *
   * 什么时候才出现（第二次用验证码登录之后）见 passkey-nudge-rules.ts。
   * 时钟在这一层读完 —— render 期间读 Date.now() 过不了 React Compiler。
   */
  const realUser = user ? await getRealUser() : null;
  const nudge = realUser && realUser.id === user?.id ? passkeyNudgeFor(realUser) : null;
  /*
   * 站点配了推送吗 —— 没配的话连提都不该提：
   * 那会是一个点了做不到的按钮，而一次做不到会让人再也不试第二回。
   */
  const pushConfigured = configProblem() === null;

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

  // 排序规则在 evaluateCheckin 里，页面只负责渲染
  const paths: CheckinPath[] =
    checkin && !checkin.verdict.ok && checkin.verdict.reason === "not_enough"
      ? checkin.verdict.paths
      : [];

  const preview =
    checkin?.verdict.ok
      ? [
          { label: "打卡", points: checkin.verdict.base },
          { label: "高质量发言", points: checkin.verdict.qualityBonus },
          { label: `连胜 ${checkin.verdict.streakAfter} 天`, points: checkin.verdict.streakBonus },
          { label: "今日互动", points: checkin.verdict.interactionBonus },
        ].filter((row) => row.points > 0)
      : [];

  return (
    <>
      <PageHeader
        title="Agentic Lab"
        subtitle={`${(memberCount?.n ?? 0).toLocaleString("zh-CN")} 位成员的 AI Agent 社区`}
        action={
          user ? null : (
            <Link
              href="/login"
              className="inline-flex min-h-11 items-center t-subhead shrink-0 rounded-[var(--radius-control)] bg-[var(--accent)] px-3.5 py-2 font-medium text-[var(--accent-ink)] transition active:scale-[0.97]"
            >
              登录
            </Link>
          )
        }
      />

      <div className="grid gap-x-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        {/* 左栏：和我有关的 */}
        <div className="min-w-0">
          {/*
            排在摘要前面 —— 这是整页唯一一个会被排到摘要之前的东西。
            理由是它只在一个人一生中出现一两次，而且一次点击就永远处理完；
            排在摘要后面的话，手机上它在第一屏之外，等于不存在。
            没有它的时候这一段完全不渲染，不留空位。
          */}
          {/*
            提示位：**一次只出一个**。

            现在有三件事想提醒：加 Passkey、装到桌面/主屏、开设备推送。
            三张卡片摞在这儿，头一屏就全是「你还没做这个」——
            而人打开首页是来看社区发生了什么的。三条同时在的结果是
            每一条都变成背景噪音，三件事一件都不会做。

            挑哪一个在 lib/nudges/rules.ts 里（按依赖排：iOS 上
            不装到主屏就收不到推送，所以那种情况下安装排在推送前面）。
            服务端只把「这个账号该不该提 Passkey」算好传下去，
            装没装、能不能推送是**这台设备**的事，只有客户端知道。
          */}
          {user && (
            <HomeNudge
              passkeyEligible={nudge !== null}
              /*
               * 站点配了 GitHub **且**他还没绑。
               *
               * 两个条件都要：没配的话整件事不存在（提了也是一个
               * 404 的按钮）；绑过的人再提就是纯粹的骚扰。
               */
              githubEligible={githubEnabled() && !connectionOf(user.id)}
              pushConfigured={pushConfigured}
            />
          )}

          {user && (
            <Section>
              <DigestCard digest={digest} loggedIn />
            </Section>
          )}

          {checkin && user && (
            <Section>
              <CheckinCard
                canCheckin={checkin.canCheckin}
                checkedToday={checkin.checkedToday}
                message={checkin.verdict.ok ? "" : checkin.verdict.message}
                paths={paths}
                streak={user.streakCurrent}
                streakBest={user.streakBest}
                budgetRemaining={checkin.budgetRemaining}
                budgetCap={checkin.budgetCap}
                preview={preview}
              />
            </Section>
          )}

          {myRank && (
            <Section title="我的本周">
              <div className="animate-rise grid grid-cols-3 gap-2.5">
                <StatTile label="排名" value={`#${myRank.rank}`} accent />
                <StatTile
                  label="高质量发言"
                  value={myRank.quality}
                  hint={`共 ${myRank.messages} 条`}
                />
                <StatTile
                  label="平均字数"
                  value={Math.round(myRank.chars / Math.max(myRank.messages, 1))}
                />
              </div>
            </Section>
          )}

          {!user && (
            <Section>
              <DigestCard digest={digest} loggedIn={false} />
            </Section>
          )}

          <Section
            title="本周贡献榜"
            action={
              <Link href="/leaderboard" className="tap-target t-footnote text-[var(--accent)]">
                查看全部
              </Link>
            }
          >
            <LeaderboardList
              entries={board}
              highlightWxId={user?.wxId}
              meHidden={meHidden}
            />
            <p className="t-caption mt-2 px-1 leading-relaxed text-[var(--ink-tertiary)]">
              按<strong className="font-medium">高质量消息</strong>排名（≥15 字的文本或引用回复）。
              按总条数排会让复读机上榜。
            </p>
          </Section>
        </div>

        {/* 右栏：社区。窄屏时它跟在主内容后面，不抢位置 */}
        <aside className="min-w-0 lg:sticky lg:top-4 lg:self-start">
          <Section title="社区脉搏">
            <div className="animate-rise grid grid-cols-3 gap-2.5 lg:grid-cols-1">
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

          {/* 群列表是隐私：只有自己所在的群才列出来，访客一个都看不到 */}
          {myGroups.length > 0 && (
            <Section
              title="我在的群"
              /*
               * 补课包的入口挂在这里，而不是主导航上。
               *
               * 它是**新人**用的东西 —— 常驻成员每天看见一个「补课」
               * 标签，只会觉得这个站在教他做人。挂在群列表旁边，
               * 想补的人找得到，不需要的人不会被反复提醒。
               */
              action={
                <Link href="/welcome" className="tap-target t-caption text-[var(--accent)]">
                  补课
                </Link>
              }
            >
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
              <Empty
                title="群聊内容与分群数据仅对成员开放"
                hint="登录后可以看到自己所在群的动态、检索历史消息，并参与社区讨论。"
                action={
                  <>
                    <EmptyAction href="/login">用微信身份登录</EmptyAction>
                    {/* 还不是成员的人也要有条路 —— 否则这一页对他是死胡同 */}
                    <Link href="/join" className="tap-target t-caption mt-3 block text-[var(--accent)]">
                      还不在群里？申请加入
                    </Link>
                  </>
                }
              />
            </Section>
          )}
        </aside>
      </div>
    </>
  );
}
