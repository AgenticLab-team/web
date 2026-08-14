import type { Metadata } from "next";
import { ForumBoardList } from "@/components/ForumBoardList";
import { forumBoard, MIN_REPLY_CHARS, POST_WEIGHT } from "@/lib/queries/forum-board";
import { leaderboardPrivacy, privacyOf } from "@/lib/privacy/queries";

import { LeaderboardList } from "@/components/LeaderboardList";
import { PageHeader } from "@/components/shell/PageHeader";
import {
  Callout,
  Empty,
  EmptyAction,
  PageNote,
  Pill,
  PillRow,
  Section,
} from "@/components/ui/primitives";
import { getCurrentUser } from "@/lib/auth/session";
import { getLeaderboard, getMyRank, PERIODS, type Period } from "@/lib/queries/leaderboard";
import { allSyncedGroupIds, visibleGroupsFor } from "@/lib/queries/visibility";
import { currentSeasonView } from "@/lib/seasons/queries";

export const metadata: Metadata = { title: "排行" ,
  /*
   * ─────────────────────────────────────────
   * 能看，但不收录
   * ─────────────────────────────────────────
   *
   * 「未登录访客还是可以看见大榜单的」是定下来的规矩，这一条不动。
   *
   * 但**「打开链接看得到」和「用名字能在谷歌里搜出来」是两件事**：
   * 后者意味着一个人的微信昵称、头像和发言量会绑在他的名字上、
   * 被任何一个搜他的人看到 —— 而他当初只是加了个微信群。
   *
   * robots.txt 里也写了一条，但那只是君子协定；
   * **真正生效的是这里** —— 不守规矩的爬虫照样会抓页面，
   * 而 noindex 是给守规矩的那些看的最后一道。
   */
  robots: { index: false, follow: true },
};
export const dynamic = "force-dynamic";

function hrefFor(period: Period, scope?: string, board?: string) {
  const params = new URLSearchParams();
  // 默认是赛季，所以只有非赛季才需要带参数
  if (period !== "season") params.set("period", period);
  if (scope) params.set("scope", scope);
  // 默认是群聊榜，同理
  if (board && board !== "chat") params.set("board", board);
  const qs = params.toString();
  return qs ? `/leaderboard?${qs}` : "/leaderboard";
}

export default async function LeaderboardPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; scope?: string; board?: string }>;
}) {
  const params = await searchParams;
  const user = await getCurrentUser();
  const myGroups = visibleGroupsFor(user);
  /*
   * 自己藏没藏 —— 只是为了在自己那一行上标一句「仅自己可见」。
   *
   * 藏起来的人榜上**还看得到自己**（排除名单里没有自己）。
   * 不标的话他看到的榜和没藏时一模一样，也就没有任何办法
   * 确认那个开关生效了 —— 而只能靠相信的隐私开关跟没有是一样的。
   */
  const meHidden = user ? privacyOf(user.id).hideFromLeaderboard : false;

  const period = (PERIODS.find((p) => p.key === params.period)?.key ?? "season") as Period;
  const season = currentSeasonView();

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

  /*
   * ═════════════════════════════════════════
   * 两个榜，不是一个混合分
   * ═════════════════════════════════════════
   *
   * 站长要「论坛活跃度也上榜单」。算一个综合分需要回答
   * 「一篇长文顶几条群消息」—— 那个问题没有答案，而随便定一个比例
   * 会变成大家优化的目标。所以并排放两个，各按各的自然单位排。
   */
  const board = params.board === "forum" ? "forum" : "chat";

  const entries = getLeaderboard({ period, convIds, limit: 50, viewer: user });

  /*
   * 论坛榜的时间范围跟着同一个 period 走 —— 两个榜切换时
   * 「本周」还是「本周」，不然人会以为数据不对。
   */
  const forumEntries =
    board === "forum"
      ? forumBoard({
          days: PERIODS.find((p) => p.key === period)?.days ?? null,
          limit: 50,
          // 和群聊榜同一份隐私名单：关掉「出现在榜单上」的人两个榜都不出现
          hiddenWxIds: leaderboardPrivacy(user).hidden,
        })
      : [];
  const myRank = getMyRank(user, { period, convIds });
  const inTop = myRank ? entries.some((e) => e.wxId === myRank.wxId) : false;

  return (
    <>
      <PageHeader
        title="排行"
        subtitle={
          period === "season" && season
            ? `${season.name} · 还剩 ${season.daysLeft} 天`
            : board === "forum"
              ? "论坛 · 按发帖与实质回复"
              : `${scopeLabel} · 按高质量消息`
        }
      />

      {/* 赛季的意义全在「还剩几天」被看见的那一刻 ——
          不显示倒计时的话，它和「本月」没有区别 */}
      {period === "season" && season && (
        <Callout tone="accent" title={`${season.name} · 还剩 ${season.daysLeft} 天`}>
          <p className="t-caption mt-1 leading-relaxed text-[var(--ink-secondary)]">
            赛季只重置<strong>排名</strong>，不动任何人的积分 ——
            攒下的分永远是你的。赛季结束时前三名会拿到称号。
          </p>
        </Callout>
      )}

      {/*
        * 榜的种类摆在最上面 —— 它比「哪一段时间」更根本：
        * 换了榜，下面那两排筛选的含义都变了。
        */}
      <PillRow>
        <Pill href={hrefFor(period, activeScope, "chat")} active={board === "chat"}>
          群聊
        </Pill>
        <Pill href={hrefFor(period, activeScope, "forum")} active={board === "forum"}>
          论坛
        </Pill>
      </PillRow>

      <PillRow wrap>
        {PERIODS.map((p) => (
          <Pill key={p.key} href={hrefFor(p.key, activeScope)} active={p.key === period}>
            {p.label}
          </Pill>
        ))}
      </PillRow>

      {/*
        * 分群范围只对成员出现，且只列自己所在的群 —— 群名对访客始终不可见。
        *
        * **论坛榜下整排不显示**：论坛的帖子不属于任何一个群，
        * 摆一排选不动的筛选，比没有更让人困惑。
        */}
      {board === "chat" && (
      <PillRow>
        <Pill href={hrefFor(period)} active={!activeScope}>
          全社区
        </Pill>
        {myGroups.length > 1 && (
          <Pill href={hrefFor(period, "mine")} active={activeScope === "mine"}>
            我的群
          </Pill>
        )}
        {myGroups.map((g) => (
          <Pill key={g.convId} href={hrefFor(period, g.convId)} active={activeScope === g.convId}>
            {g.name}
          </Pill>
        ))}
      </PillRow>
      )}

      {/* 自己不在前 50 时单独把名次拎出来，否则这个人永远看不到自己 */}
      {board === "chat" && myRank && !inTop && (
        <Section title="我的名次">
          <LeaderboardList entries={[myRank]} highlightWxId={user?.wxId} meHidden={meHidden} />
        </Section>
      )}

      <Section>
        {board === "forum" ? (
          <ForumBoardList entries={forumEntries} highlightWxId={user?.wxId} />
        ) : (
          <LeaderboardList
            entries={entries}
            highlightWxId={user?.wxId}
            showDelta={period !== "all"}
            meHidden={meHidden}
          />
        )}
      </Section>

      <PageNote>
        {board === "forum" ? (
          <>
            发帖算 {POST_WEIGHT} 分、
            <strong>有实质内容</strong>的回复（≥ {MIN_REPLY_CHARS} 字）算 1 分 ——
            按条数排的话，冠军会是那个在每篇底下回「+1」的人。
            <br />
            <strong>匿名帖不计入</strong>：数字本身不说出是哪几篇，但在一个几十人的社区里，
            「某人的计数从 0 变成 1」和「今天出现了一篇匿名帖」放在一起就够指认了。
            <br />
            群聊榜和论坛榜<strong>不合并成一个分数</strong> ——
            那需要回答「一篇长文顶几条群消息」，而那个问题没有答案，
            随便定一个比例只会变成大家优化的目标。
          </>
        ) : (
          <>
            高质量消息 = 长度 ≥ 15 字的文本或引用回复，口径与群里机器人报的排名一致。
            {period !== "all" && "箭头是相对上一个同长度周期的名次变化。"}
          </>
        )}
        {!user && (
          <>
            {" "}
            还没加入本站的群成员在这里<strong>不具名</strong> ——
            名次和条数是真的，只是名字和头像要等他自己来了才显示。
          </>
        )}
      </PageNote>

      {!user && (
        <Empty
          title="想看自己所在群的榜单？"
          action={<EmptyAction href="/login">登录</EmptyAction>}
        />
      )}
    </>
  );
}
