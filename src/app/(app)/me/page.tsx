import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { after } from "next/server";

import { ChevronRight } from "lucide-react";

import { Avatar } from "@/components/Avatar";
import { SharePrompts } from "@/components/github/SharePrompts";
import { PageHeader } from "@/components/shell/PageHeader";
import { ThemeToggle } from "@/components/ThemeToggle";
import { TitleIcon } from "@/components/titles/TitleIcon";
import { TitleShelf } from "@/components/titles/TitleShelf";
import { Empty, Group, Row, Section, StatTile } from "@/components/ui/primitives";
import { getCurrentUser, getRealUser } from "@/lib/auth/session";
import { connectionOf } from "@/lib/github/link";
import { expireStalePrompts, listPendingPrompts } from "@/lib/github/prompts";
import { refreshIfStale } from "@/lib/github/repos";
import { githubEnabled } from "@/lib/github/secret";
import { db } from "@/lib/db";
import { dailyStats, groupMembers, people, roles, userRoles } from "@/lib/db/schema";
import { listPasskeys } from "@/lib/auth/passkey";
import { bookmarkTabs } from "@/lib/forum/bookmark-queries";
import { draftCount } from "@/lib/forum/drafts";
import { listFollows } from "@/lib/forum/follow";
import { getMyRank } from "@/lib/queries/leaderboard";
import { visibleGroupsFor } from "@/lib/queries/visibility";
import { mySkills } from "@/lib/members/queries";
import { privacyOf } from "@/lib/privacy/queries";
import { hiddenCount } from "@/lib/privacy/rules";
import { isAlwaysOn } from "@/lib/notifications/prefs";
import { getPrefs } from "@/lib/notifications/store";
import { equippedTitle, titlesOf } from "@/lib/titles/queries";
import { rarityColor } from "@/lib/titles/rules";
import { resolveDisplayName } from "@/lib/users/display-name";
import { roleInk, roleTint } from "@/lib/ui/role-color";
import { shiftDateKey, todayKey } from "@/lib/time";

export const metadata: Metadata = { title: "我的" };
export const dynamic = "force-dynamic";

export default async function MePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const wxId = user.wxId;
  const profile = wxId ? db.select().from(people).where(eq(people.wxId, wxId)).get() : null;
  const name = resolveDisplayName([user.siteNickname, user.wxNickname, profile?.displayName], {
    wxId,
    fallback: "我",
  });

  const skillCount = mySkills(user.id).length;
  const privacyHidden = hiddenCount(privacyOf(user.id));
  const prefs = getPrefs(user.id);
  const mutedTypes = Object.entries(prefs).filter(
    ([type, v]) => !v.site && !isAlwaysOn(type),
  ).length;

  const heldRoles = db
    .select({ name: roles.name, color: roles.color, priority: roles.priority })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(userRoles.userId, user.id), isNull(userRoles.revokedAt)))
    .orderBy(desc(roles.priority))
    .all();

  // 走统一的可见性收口，而不是自己再拼一遍成员查询 ——
  // 两处各写一遍，早晚有一处忘了过滤已退群的记录
  const myGroups = visibleGroupsFor(user);
  const convIds = myGroups.map((g) => g.convId);

  const myMessageCounts = new Map(
    wxId
      ? db
          .select({ convId: groupMembers.convId, messages: groupMembers.messages })
          .from(groupMembers)
          .where(and(eq(groupMembers.wxId, wxId), isNull(groupMembers.leftAt)))
          .all()
          .map((r) => [r.convId, r.messages])
      : [],
  );

  const passkeyCount = listPasskeys(user.id).length;
  const bookmarkCount = bookmarkTabs(user.id).all;
  const followCount = listFollows(user.id).length;
  const drafts = draftCount(user.id);

  const weekRank = convIds.length ? getMyRank(user, { period: "week", convIds }) : null;
  const today = todayKey();

  const todayStat = wxId && convIds.length
    ? db
        .select({
          messages: sql<number>`coalesce(sum(${dailyStats.messages}), 0)`,
          quality: sql<number>`coalesce(sum(${dailyStats.qualityMessages}), 0)`,
        })
        .from(dailyStats)
        .where(
          and(
            eq(dailyStats.wxId, wxId),
            eq(dailyStats.date, today),
            inArray(dailyStats.convId, convIds),
          ),
        )
        .get()
    : null;

  // 近 12 周的活跃日历，用来做贡献热力条
  const since = shiftDateKey(today, -83);
  const activeDays = wxId && convIds.length
    ? db
        .select({ date: dailyStats.date, quality: sql<number>`sum(${dailyStats.qualityMessages})` })
        .from(dailyStats)
        .where(
          and(
            eq(dailyStats.wxId, wxId),
            sql`${dailyStats.date} >= ${since}`,
            inArray(dailyStats.convId, convIds),
          ),
        )
        .groupBy(dailyStats.date)
        .all()
    : [];
  const byDate = new Map(activeDays.map((d) => [d.date, Number(d.quality)]));

  const ownedTitles = titlesOf(user.id);
  const equipped = equippedTitle(user.id);

  /*
   * ─────────────────────────────────────────
   * GitHub 的「要不要发个帖」提示
   * ─────────────────────────────────────────
   *
   * **只对本人。** 用 getRealUser() 而不是上面那个 user ——
   * 管理员预览别人时，`user` 是被预览的那个人，
   * 而这些提示里带着他还没公开的新仓库名。提示是私事，
   * 连「以他的视角看看」也不该看到。
   *
   * 渲染阶段只读库、一个网络请求都不发。真正去 GitHub 抓数据
   * 挂在 after() 上，跑在**响应发出之后** —— 见 lib/github/repos.ts
   * 里那段关于「谁来刷新」的说明。
   */
  const realUser = await getRealUser();
  const isSelf = realUser?.id === user.id;
  const githubConn = githubEnabled() && isSelf ? connectionOf(user.id) : null;

  if (githubConn?.promptEnabled) {
    // 先把挂太久的收起来，再列 —— 顺序反了的话会先摆出一条马上要过期的
    expireStalePrompts(user.id);
  }
  const sharePrompts = githubConn?.promptEnabled ? listPendingPrompts(user.id) : [];

  if (githubConn) {
    const targetId = user.id;
    after(() => refreshIfStale(targetId));
  }

  return (
    <>
      <PageHeader title="我的" />

      <Section>
        <div className="inset-group animate-rise flex items-center gap-4 p-5">
          <Avatar wxId={wxId ?? user.id} name={name} src={user.wxAvatarUrl ?? profile?.avatarUrl} size={60} />
          <div className="min-w-0 flex-1">
            <p className="t-title3 flex items-center gap-1.5 truncate">
              <span className="truncate">{name}</span>
              {equipped && (
                <span
                  className="t-caption flex shrink-0 items-center gap-1 rounded-[var(--radius-pill)] px-1.5 py-0.5 font-medium"
                  style={{
                    background: `color-mix(in srgb, ${rarityColor(equipped.rarity)} 14%, transparent)`,
                    color: rarityColor(equipped.rarity),
                  }}
                >
                  {/* 称号图标走 TitleIcon 映射成 SVG —— 成员目录已经这么做了，
                      「我的」页直接渲染 emoji 的话，同一个称号在两页长得不一样 */}
                  <TitleIcon icon={equipped.icon} className="h-3 w-3" />
                  {equipped.name}
                </span>
              )}
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {heldRoles.map((role) => (
                <span
                  key={role.name}
                  className="t-caption rounded-[var(--radius-pill)] px-2 py-0.5 font-medium"
                  style={{ background: roleTint(role.color), color: roleInk(role.color) }}
                >
                  {role.name}
                </span>
              ))}
            </div>
          </div>
        </div>
      </Section>

      {/*
        提示排在称号前面，但没有角标、没有小红点，也不进通知中心。
        它说的是「你可以做一件事」，不是「你有事没做」——
        后者用久了会让人学会无视这整块区域。
        没有待处理的提示时这一段完全不出现。
      */}
      {sharePrompts.length > 0 && (
        <Section title="有件事可以说给群里听">
          <SharePrompts
            items={sharePrompts.map((p) => ({
              id: p.id,
              kind: p.kind,
              title: p.title,
              url: p.url,
              summary: p.summary,
              repoFullName: p.repoFullName,
            }))}
          />
        </Section>
      )}

      <Section title="称号">
        <TitleShelf titles={ownedTitles} />
      </Section>

      <Section title="收藏、草稿与关注">
        <Group>
          <Row href="/me/bookmarks">
            <span className="t-body flex-1">收藏夹</span>
            <span className="t-footnote text-[var(--ink-tertiary)]">
              {bookmarkCount === 0 ? "还没收藏过" : `${bookmarkCount} 条`}
            </span>
            <ChevronRight
              className="h-4 w-4 shrink-0 text-[var(--ink-quaternary)]"
              strokeWidth={2}
              aria-hidden
            />
          </Row>
          <Row href="/me/drafts">
            <span className="t-body flex-1">草稿箱</span>
            <span className="t-footnote text-[var(--ink-tertiary)]">
              {drafts === 0 ? "没有写到一半的" : `${drafts} 份没写完`}
            </span>
            <ChevronRight
              className="h-4 w-4 shrink-0 text-[var(--ink-quaternary)]"
              strokeWidth={2}
              aria-hidden
            />
          </Row>
          <Row href="/me/following">
            <span className="t-body flex-1">我关注的</span>
            <span className="t-footnote text-[var(--ink-tertiary)]">
              {followCount === 0 ? "还没关注过" : `${followCount} 个`}
            </span>
            <ChevronRight
              className="h-4 w-4 shrink-0 text-[var(--ink-quaternary)]"
              strokeWidth={2}
              aria-hidden
            />
          </Row>
        </Group>
      </Section>

      <Section title="积分">
        <Group>
          <Row href="/me/points">
            <span className="t-body flex-1">积分与等级</span>
            <span className="tabular t-footnote text-[var(--ink-tertiary)]">
              {user.points} 分 · L{user.level}
            </span>
            <ChevronRight
              className="h-4 w-4 shrink-0 text-[var(--ink-quaternary)]"
              strokeWidth={2}
              aria-hidden
            />
          </Row>
        </Group>
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
                  {myMessageCounts.get(g.convId) ?? 0} 条
                </span>
              </Row>
            ))}
          </Group>
        )}
      </Section>

      <Section title="外观">
        <div className="inset-group p-3">
          <ThemeToggle />
        </div>
        <p className="t-caption mt-2 px-1 text-[var(--ink-tertiary)]">
          「自动」跟随系统设置。
        </p>
      </Section>

      <Section title="账号">
        <Group>
          <Row href="/me/security">
            <span className="t-body flex-1">登录与安全</span>
            <span className="t-footnote text-[var(--ink-tertiary)]">
              {passkeyCount ? `${passkeyCount} 个 Passkey` : "未设置 Passkey"}
            </span>
            <ChevronRight
              className="h-4 w-4 shrink-0 text-[var(--ink-quaternary)]"
              strokeWidth={2}
              aria-hidden
            />
          </Row>
          <Row href="/me/profile">
            <span className="t-body flex-1">个人资料</span>
            <span className="t-footnote text-[var(--ink-tertiary)]">
              {skillCount === 0 ? "还没填技能标签" : `${skillCount} 个技能标签`}
            </span>
            <ChevronRight
              className="h-4 w-4 shrink-0 text-[var(--ink-quaternary)]"
              strokeWidth={2}
              aria-hidden
            />
          </Row>
          {/*
            * 隐私摆在个人资料后面、通知设置前面。
            *
            * 它管的是「谁能找到你说过的话」，而个人资料那一项管的是
            * 「谁能找到你这个人」—— 两件事挨着放，人才会把它们
            * 当成一组来想。摘要要说「藏起来了几样」而不是「已开启」：
            * 一个三个月前关过某个开关的人根本想不起来自己关过，
            * 然后会来问「为什么我不在榜上」。
            */}
          <Row href="/me/privacy">
            <span className="t-body flex-1">隐私</span>
            <span className="t-footnote text-[var(--ink-tertiary)]">
              {privacyHidden === 0 ? "都是公开的" : `藏起来了 ${privacyHidden} 样`}
            </span>
            <ChevronRight
              className="h-4 w-4 shrink-0 text-[var(--ink-quaternary)]"
              strokeWidth={2}
              aria-hidden
            />
          </Row>
          {/*
            * 导出紧挨着隐私。
            *
            * 两项管的是同一件事的两面：隐私决定「别人能看到你的什么」，
            * 导出决定「你能把自己的什么带走」。摘要里直接写出
            * 「含别人的发言」—— 这是点进去之前就该知道的事，
            * 不该等到解压之后才发现。
            */}
          <Row href="/me/export">
            <span className="t-body flex-1">导出我的数据</span>
            <span className="t-footnote text-[var(--ink-tertiary)]">zip · 含上下文</span>
            <ChevronRight
              className="h-4 w-4 shrink-0 text-[var(--ink-quaternary)]"
              strokeWidth={2}
              aria-hidden
            />
          </Row>
          <Row href="/me/notifications">
            <span className="t-body flex-1">通知设置</span>
            <span className="t-footnote text-[var(--ink-tertiary)]">
              {mutedTypes === 0 ? "全部开启" : `关了 ${mutedTypes} 类`}
            </span>
            <ChevronRight
              className="h-4 w-4 shrink-0 text-[var(--ink-quaternary)]"
              strokeWidth={2}
              aria-hidden
            />
          </Row>
          <Row href="/me/moderation">
            <span className="t-body flex-1">处罚与申诉</span>
            <ChevronRight
              className="h-4 w-4 shrink-0 text-[var(--ink-quaternary)]"
              strokeWidth={2}
              aria-hidden
            />
          </Row>
          {/*
            * ⚠ 只给本人看。
            *
            * 这一页取当前用户走的是 getCurrentUser()，而它在预览态下返回的是
            * **被预览的那个人** —— 也就是说管理员「以他的视角看看」的时候，
            * 这一行会把他的微信 ID 摆出来。拿着微信 ID 就能在微信里直接加人，
            * 而这个站的其他地方为了不泄露它，专门绕了一条
            * /members/by/<账号 id> 的中转（见 lib/members/queries.ts）。
            *
            * 判据用 isSelf（realUser 和 user 是同一个人），
            * 和这一页上 GitHub 提示那一段同一条线。
            */}
          {isSelf && (
            <Row>
              <span className="t-body flex-1">微信 ID</span>
              <span className="t-footnote font-mono text-[var(--ink-tertiary)]">{wxId}</span>
            </Row>
          )}
        </Group>
        {passkeyCount === 0 && (
          <p className="t-caption mt-2 px-1 leading-relaxed text-[var(--ink-tertiary)]">
            设置 Passkey 后用指纹或面容一步登录，不必每次回微信取验证码。
          </p>
        )}
      </Section>

      <Section>
        <Group>
          {/* 必须是表单 POST，不能做成指向退出接口的 Link：
              Link 在生产环境会被自动预取，预取的 GET 就把会话撤销了 ——
              这正是「一刷新就掉登录」的根因，见 tests/logout.test.ts */}
          <form action="/api/auth/logout" method="post">
            <button
              type="submit"
              className="inset-row flex w-full items-center justify-center px-4 py-3 transition-colors hover:bg-[var(--fill)]"
            >
              <span className="t-body text-[var(--danger)]">退出登录</span>
            </button>
          </form>
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
