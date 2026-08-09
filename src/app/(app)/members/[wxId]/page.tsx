import { EyeOff } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Avatar } from "@/components/Avatar";
import { FollowButton } from "@/components/forum/FollowButton";
import { RepoShowcase } from "@/components/github/RepoShowcase";
import { publicConnectionOf } from "@/lib/github/link";
import { showcaseFor } from "@/lib/github/repos";
import { githubEnabled } from "@/lib/github/secret";
import { PageHeader } from "@/components/shell/PageHeader";
import { Card, PageNote, Section, StatTile } from "@/components/ui/primitives";
import { getCurrentUser } from "@/lib/auth/session";
import { messageLink } from "@/lib/messages/archive-rules";
import {
  mentionCountFor,
  recentMentionsFor,
  replyReceivedCountFor,
} from "@/lib/messages/interactions";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { isFollowing } from "@/lib/forum/follow";
import { personProfileFor } from "@/lib/members/person";
import { visibleGroupsFor } from "@/lib/queries/visibility";
import { dateKey } from "@/lib/time";
import { eq } from "drizzle-orm";

export const metadata: Metadata = { title: "成员主页" };
export const dynamic = "force-dynamic";

/**
 * 成员主页 —— @提及 点进来落的地方。
 *
 * ─────────────────────────────────────────
 * 可见性与成员目录同一条线
 * ─────────────────────────────────────────
 *
 * 只有**和这个人同群**的登录成员能打开；其他人一律 404 ——
 * 403 会泄露「这个 wx_id 存在」。页面内容也只取自共同群：
 * 一个只跟他同在 #1 群的人，不该从这里看到他在别的群的动静。
 *
 * 这一页展示的都是共同群成员在微信里本来就看得到的东西
 * （昵称、头像、发言），只是加了聚合 —— 不额外暴露任何新事实。
 */
export default async function PersonPage({
  params,
}: {
  params: Promise<{ wxId: string }>;
}) {
  const { wxId: raw } = await params;
  const wxId = decodeURIComponent(raw);

  const user = await getCurrentUser();
  const visibleGroups = visibleGroupsFor(user);
  if (visibleGroups.length === 0) notFound();

  const profile = personProfileFor(wxId, visibleGroups);
  if (!profile) notFound();

  const convIds = profile.sharedGroups.map((g) => g.convId);
  const mentionCount = mentionCountFor(wxId, convIds);
  const replyCount = replyReceivedCountFor(wxId, convIds);
  const recentMentions = recentMentionsFor(wxId, convIds, 10);
  const groupName = new Map(profile.sharedGroups.map((g) => [g.convId, g.name]));

  /*
   * 关注按钮只在这个人**有站内账号**时出现。
   *
   * 关注的意思是「他发新帖时叫我」，而发帖需要账号 ——
   * 给一个只在群里说话、没注册过的人挂一个关注按钮，
   * 点了之后永远不会有任何动静。
   */
  const account = db.select({ id: users.id }).from(users).where(eq(users.wxId, wxId)).get();
  const canFollowThem = Boolean(account) && account!.id !== user?.id;
  const followingThem =
    canFollowThem && user ? isFollowing(user.id, "user", account!.id) : false;

  /*
   * GitHub 项目。
   *
   * 三道门都得过：站里配了 OAuth、这个人绑了、**而且他自己打开了展示开关**。
   * 任何一道不过就是 `null`，那一整段（连标题带边框）从页面上消失 ——
   * 不是显示一个空的「GitHub」区块。
   *
   * 空区块有两个问题：它让绝大多数人的主页多一块没内容的地方，
   * 而且它把「这个人没绑 GitHub」变成了一条对所有同群的人公开的信息。
   *
   * 数据只读缓存表，**这一页一个网络请求都不发** ——
   * 每次渲染都打 GitHub API 的话，GitHub 的限流是按服务器 IP 算的，
   * 有人来回刷几个主页就能把全站的额度耗光。
   */
  const githubConn =
    githubEnabled() && account ? publicConnectionOf(account.id) : null;
  const githubRepos = githubConn ? showcaseFor(githubConn.userId, githubConn.pinnedRepos) : [];

  return (
    <>
      <PageHeader
        title="成员主页"
        action={
          canFollowThem ? (
            <FollowButton target="user" targetId={account!.id} following={followingThem} />
          ) : null
        }
      />

      <Card className="mb-4 flex items-center gap-4">
        <Avatar wxId={wxId} name={profile.name} src={profile.avatarUrl} size={56} />
        <div className="min-w-0 flex-1">
          <p className="t-title3 font-semibold">{profile.name}</p>
          <p className="t-caption mt-0.5 text-[var(--ink-tertiary)]">
            {profile.sharedGroups.map((g) => g.name).join(" · ")}
          </p>
        </div>
      </Card>

      <div className="mb-4 grid grid-cols-3 gap-2.5">
        <StatTile label="发言" value={profile.messages} />
        <StatTile label="被 @" value={mentionCount} />
        <StatTile label="被回复" value={replyCount} />
      </div>

      {githubConn && githubRepos.length > 0 && (
        <Section title="GitHub 项目">
          <RepoShowcase repos={githubRepos} login={githubConn.login} />
        </Section>
      )}

      {recentMentions.length > 0 && (
        <Section title="最近被 @">
          <div className="inset-group">
            {recentMentions.map((m) => (
              <Link
                key={m.messageId}
                /* 直达那一条并高亮，而不是「落到那一天自己找」—— 见 lib/messages/archive-rules.ts */
                href={messageLink(m.messageId, { convId: m.convId, date: dateKey(m.ts) })}
                className="inset-row block px-4 py-2.5 transition active:opacity-70"
              >
                <p className="t-caption flex items-baseline justify-between gap-2 text-[var(--ink-secondary)]">
                  <span className="min-w-0 truncate font-medium">
                    {m.senderName ?? "成员"} · {groupName.get(m.convId) ?? "群聊"}
                  </span>
                  <span className="tabular t-caption2 shrink-0 text-[var(--ink-quaternary)]">
                    {dateKey(m.ts)}
                  </span>
                </p>
                <p className="t-subhead mt-0.5 line-clamp-2 break-words leading-relaxed">
                  {m.content}
                </p>
              </Link>
            ))}
          </div>
        </Section>
      )}

      <PageNote className="flex gap-1.5">
        <EyeOff className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={2} aria-hidden />
        <span>
          这一页只对<strong>同群成员</strong>可见，且只统计你们的共同群 ——
          这里没有任何你在微信里看不到的东西。
        </span>
      </PageNote>
    </>
  );
}
