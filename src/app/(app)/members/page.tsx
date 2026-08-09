import { EyeOff, UserRoundSearch } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Avatar } from "@/components/Avatar";
import { PersonLink } from "@/components/PersonLink";

/**
 * 目录里那一行链到哪。
 *
 * 走账号 id 的中转，不直接拼 wx_id —— 见 lib/members/queries.ts
 * 里 `hasProfile` 那段：目录里有一群从没在群里说过话的人，
 * 他们的 wx_id 不该因为「让头像可以点」就摊在页面源码里。
 */
function profileHref(member: { id: string; isMe: boolean; hasProfile: boolean }): string | null {
  if (member.isMe || !member.hasProfile) return null;
  return `/members/by/${member.id}`;
}
import { PageHeader } from "@/components/shell/PageHeader";
import { Card, Empty, PageNote, Pill, PillRow, Section } from "@/components/ui/primitives";
import { getCurrentUser } from "@/lib/auth/session";
import { memberDirectory } from "@/lib/members/queries";
import { isDirectoryHidden } from "@/lib/members/queries";
import { rarityColor } from "@/lib/titles/rules";
import { TitleIcon } from "@/components/titles/TitleIcon";

export const metadata: Metadata = { title: "成员" };
export const dynamic = "force-dynamic";

/**
 * 成员目录。
 *
 * ─────────────────────────────────────────
 * 这一页刻意比想象中小
 * ─────────────────────────────────────────
 *
 * 群成员表里有一千八百人，这里只有二十几个 ——
 * 因为只收录**注册用户**，而且只显示**和你同群的**。
 *
 * 把一千八百人放上来会好看得多，也会更像一个「社区」，
 * 但那一千七百多人从没同意过自己出现在一个可按技能检索的网页上。
 * 目录小是事实，把它显示成大的才是问题。
 *
 * 所以页面上直说：收录了几个、还有几个隐身了、几个人没填标签。
 * 一个说得出自己有多空的目录，比一个看起来很满的目录有用。
 */
export default async function MembersPage({
  searchParams,
}: {
  searchParams: Promise<{ tag?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/members");

  const { tag } = await searchParams;
  const dir = memberDirectory(user, { tag });
  const meHidden = isDirectoryHidden(user.id);
  const activeFacet = dir.facets.find((f) => f.slug === tag);

  return (
    <>
      <PageHeader
        title="成员"
        subtitle={
          dir.total === 0
            ? "还没有可见的成员"
            : `${dir.total} 位同群的注册成员${dir.hidden > 0 ? ` · ${dir.hidden} 位隐身` : ""}`
        }
        action={
          <Link
            href="/me/profile"
            className="t-subhead text-[var(--accent)] transition active:opacity-60"
          >
            我的资料
          </Link>
        }
      />

      {dir.moduleOff ? (
        /* 「被关了」和「本来就是空的」在页面上长得一模一样 —— 必须分开说 */
        <Empty
          title="成员目录已关闭"
          hint="管理员在后台停用了这个模块。大家填过的技能标签都还在，重新打开就会回来"
        />
      ) : dir.total === 0 ? (
        <Empty
          title="目录是空的"
          hint="只收录和你同群的注册用户 —— 群里绝大多数人还没在站上注册过"
        />
      ) : (
        <>
          {dir.facets.length > 0 && (
            <PillRow>
              <Pill href="/members" active={!tag}>
                全部
              </Pill>
              {dir.facets.map((facet) => (
                <Pill
                  key={facet.slug}
                  href={`/members?tag=${encodeURIComponent(facet.slug)}`}
                  active={tag === facet.slug}
                >
                  {facet.label}
                  <span className="tabular ml-1 opacity-55">{facet.count}</span>
                </Pill>
              ))}
            </PillRow>
          )}

          {/* 目录的价值完全取决于有多少人填了标签 —— 说出来，顺便给个入口 */}
          {dir.untagged > 0 && !tag && (
            <Link
              href="/me/profile"
              className="mb-3 flex items-center gap-2.5 rounded-[var(--radius-card)] bg-[var(--surface)] p-4 transition hairline active:opacity-70"
            >
              <UserRoundSearch
                className="h-4 w-4 shrink-0 text-[var(--accent)]"
                strokeWidth={2}
                aria-hidden
              />
              <span className="min-w-0 flex-1">
                <span className="t-subhead block">
                  {dir.untagged} 位成员还没填技能标签
                </span>
                <span className="t-caption block leading-relaxed text-[var(--ink-tertiary)]">
                  按技能找人这件事，要够多人填了才成立。填一下你自己的 →
                </span>
              </span>
            </Link>
          )}

          <Section
            title={activeFacet ? `${activeFacet.label} · ${dir.members.length} 人` : undefined}
          >
            {dir.members.length === 0 ? (
              <Empty title="这个标签下没有人" hint="换一个标签，或者看全部" />
            ) : (
              <div className="space-y-2">
                {dir.members.map((member) => (
                  <Card as="article" key={member.id}>
                    <div className="flex gap-3">
                      {/* 目录里的人本来点不动 —— 一本点不开的通讯录 */}
                      <PersonLink href={profileHref(member)} name={member.name}>
                        <Avatar src={member.avatarUrl} paletteIndex={member.paletteIndex} name={member.name} size={40} />
                      </PersonLink>

                      <div className="min-w-0 flex-1">
                        <p className="t-body flex flex-wrap items-center gap-1.5 font-medium">
                          <PersonLink
                            href={profileHref(member)}
                            name={member.name}
                            className="hover:underline"
                          >
                            {member.name}
                          </PersonLink>
                          {member.title && (
                            <span
                              className="t-caption2 rounded-full px-1.5 py-0.5"
                              style={{
                                color: rarityColor(member.title.rarity),
                                background: `color-mix(in srgb, ${rarityColor(member.title.rarity)} 12%, transparent)`,
                              }}
                            >
                              <TitleIcon icon={member.title.icon} className="h-3 w-3" />
                              {member.title.name}
                            </span>
                          )}
                          {member.isMe && (
                            <span className="t-caption2 text-[var(--ink-quaternary)]">
                              {meHidden ? "仅自己可见" : "这是你"}
                            </span>
                          )}
                        </p>

                        {member.bio && (
                          <p className="t-caption mt-1 leading-relaxed text-[var(--ink-secondary)]">
                            {member.bio}
                          </p>
                        )}

                        {member.tags.length > 0 ? (
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {member.tags.map((t) => (
                              <Link
                                key={t.slug}
                                href={`/members?tag=${encodeURIComponent(t.slug)}`}
                                className="t-caption2 rounded-full bg-[var(--fill)] px-2 py-0.5 text-[var(--ink-secondary)] transition active:opacity-60"
                              >
                                {t.label}
                              </Link>
                            ))}
                          </div>
                        ) : (
                          member.isMe && (
                            <Link
                              href="/me/profile"
                              className="t-caption2 mt-1.5 inline-block text-[var(--accent)]"
                            >
                              加上你的技能标签 →
                            </Link>
                          )
                        )}

                        {/* 只说共同群的**数量**，不说是哪个 ——
                            说了就等于把群名泄露给了另一个群的人 */}
                        <p className="t-caption2 mt-1.5 text-[var(--ink-quaternary)]">
                          {member.sharedGroups > 0 && `${member.sharedGroups} 个共同群`}
                          {member.points > 0 && ` · ${member.points} 积分`}
                        </p>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </Section>
        </>
      )}

      <PageNote className="flex gap-1.5">
        <EyeOff className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={2} aria-hidden />
        <span>
          目录只收录<strong>在站上注册过</strong>的人，而且只显示和你<strong>同群</strong>的 ——
          群里绝大多数人从没同意过出现在一个可按技能检索的网页上。
          不想出现可以在
          <Link href="/me/profile" className="text-[var(--accent)]">
            个人资料
          </Link>
          里隐身。
        </span>
      </PageNote>
    </>
  );
}
