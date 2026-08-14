import { ArrowRight, Link2 } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Avatar } from "@/components/Avatar";
import { RhythmBars } from "@/components/onboarding/RhythmBars";
import { PageHeader } from "@/components/shell/PageHeader";
import { Card, Empty, Group, PageNote, Row, Section, StatTile } from "@/components/ui/primitives";
import { getCurrentUser } from "@/lib/auth/session";
import { groupCatchup, hasEnoughToShow, type GroupCatchup } from "@/lib/onboarding/catchup";
import { visibleGroupsFor } from "@/lib/queries/visibility";

export const metadata: Metadata = { title: "补课" };
export const dynamic = "force-dynamic";

/**
 * 新人补课包。
 *
 * ─────────────────────────────────────────
 * 这一页要解决的是「插不进话」
 * ─────────────────────────────────────────
 *
 * 一个刚绑定的人打开这个站，面对的是 45,000 条他没有上下文的记录。
 * 他不知道这个群平时聊什么、谁是常驻、什么时候开口有人接 ——
 * 于是他不说话，两周后退群。
 *
 * 线上 118 个账号**全部是最近 30 天绑定的**，
 * 也就是说现在整站的人都正处在这个状态。
 *
 * ─────────────────────────────────────────
 * 每一屏都要能**当场用**
 * ─────────────────────────────────────────
 *
 * 所以这里不写「本群共有 11,631 条消息」这种读完就忘的数字，
 * 而是：几点开口有人接、认识这几张脸、点进最热闹的那天看看、
 * 这几条链接是群里反复贴的。
 *
 * 每一节末尾都有一个**去哪里**的出口 —— 补课包本身不是目的地，
 * 它是把新人送进检索、归档、资源库的那道门。
 */
export default async function WelcomePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/welcome");

  const groups = visibleGroupsFor(user);
  const packs = groups
    .map((g) => groupCatchup(user, g.convId))
    .filter((p): p is GroupCatchup => p !== null && hasEnoughToShow(p));

  if (packs.length === 0) {
    return (
      <>
        <PageHeader title="补课" subtitle="进群晚了没关系，先把上下文补上" />
        <Empty
          title="还没有可以补的课"
          hint="等这个群的记录同步进来，这里会出现它的节奏、常驻成员和大家分享过的东西。"
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="补课"
        subtitle={
          packs.length === 1
            ? "进群晚了没关系，先把上下文补上"
            : `你在 ${packs.length} 个群里 —— 一个一个来`
        }
      />

      {packs.map((pack) => (
        <GroupPack key={pack.convId} pack={pack} />
      ))}

      <PageNote>
        这一页上的每个数字都是数出来的，没有「精选」——
        这个站目前没有可靠的办法判断哪条群聊消息更好，
        与其编一个榜，不如把真实的节奏给你。
      </PageNote>
    </>
  );
}

function GroupPack({ pack }: { pack: GroupCatchup }) {
  const busiestHour = pack.hours.indexOf(Math.max(...pack.hours));

  return (
    <section className="mb-10">
      <div className="mb-3 px-1">
        <h2 className="t-title3">{pack.name}</h2>
        <p className="t-caption mt-0.5 text-[var(--ink-tertiary)]">
          {pack.memberCount} 人 · {pack.messageCount.toLocaleString("zh-CN")} 条记录
          {pack.firstDay && ` · 从 ${pack.firstDay} 开始`}
        </p>
      </div>

      {/*
        节奏放在最前面。

        它是这一页里**唯一一个新人今天就能用上**的东西：
        知道几点开口有人接，比知道这个群有多少条消息有用得多。
      */}
      <Card className="mb-3">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <p className="t-subhead font-medium">一天里的节奏</p>
          <p className="t-caption text-[var(--ink-tertiary)]">
            最热闹是 {busiestHour}:00 前后
          </p>
        </div>
        <RhythmBars hours={pack.hours} />
      </Card>

      {/*
        三个数字用现成的 StatTile。

        这里本来手写了一版更紧凑的格子 —— 但那正是这个站以前
        长出三份 Metric/Tile/PendingTile 的方式。少一个克隆，
        比这一页好看一点更要紧。
      */}
      <div className="mb-3 grid grid-cols-3 gap-2">
        <StatTile label="活跃日均" value={pack.perActiveDay} hint="条" />
        <StatTile label="有人说话" value={pack.activeDays} hint="天" />
        <StatTile label="近 30 天" value={pack.recentSpeakers} hint="人开口" />
      </div>

      {pack.voices.length > 0 && (
        <Section title="先认识这几位">
          <Group>
            {pack.voices.map((v) => (
              <Row key={v.wxId} href={`/members/${encodeURIComponent(v.wxId)}`}>
                <Avatar wxId={v.wxId} name={v.name} src={v.avatarUrl} size={36} />
                <div className="min-w-0 flex-1">
                  <p className="t-subhead truncate">
                    {v.name}
                    {v.isYou && (
                      <span className="ml-1.5 text-[var(--ink-tertiary)]">（你）</span>
                    )}
                  </p>
                  <p className="t-caption text-[var(--ink-tertiary)]">
                    {v.quality.toLocaleString("zh-CN")} 条有效发言
                    {v.peakHour !== null && ` · 常在 ${v.peakHour}:00 前后`}
                  </p>
                </div>
                <ArrowRight size={15} className="shrink-0 text-[var(--ink-quaternary)]" />
              </Row>
            ))}
          </Group>
        </Section>
      )}

      {pack.busiestDays.length > 0 && (
        <Section title="最热闹的几天">
          {/*
            链到按天回看。

            这一节是整页里最像「补课」的一节 —— 与其读一堆统计，
            不如直接翻进那天的现场。所以每一行都是可点的，
            落点是归档里的那一天。
          */}
          <Group>
            {pack.busiestDays.map((d) => (
              <Row
                key={d.date}
                href={`/archive?group=${encodeURIComponent(pack.convId)}&date=${d.date}`}
              >
                <div className="min-w-0 flex-1">
                  <p className="t-subhead tabular-nums">{d.date}</p>
                  <p className="t-caption text-[var(--ink-tertiary)]">
                    {d.messages.toLocaleString("zh-CN")} 条 · {d.speakers} 人参与
                  </p>
                </div>
                <ArrowRight size={15} className="shrink-0 text-[var(--ink-quaternary)]" />
              </Row>
            ))}
          </Group>
        </Section>
      )}

      {pack.links.length > 0 && (
        <Section
          title="群里反复贴过的"
          action={
            <Link href="/links" className="t-caption text-[var(--accent)]">
              全部资源
            </Link>
          }
        >
          <Group>
            {pack.links.map((l) => (
              <Row key={l.id} href={`/links#${l.id}`}>
                <Link2 size={15} className="shrink-0 text-[var(--ink-quaternary)]" />
                <div className="min-w-0 flex-1">
                  <p className="t-subhead truncate">{l.title}</p>
                  <p className="t-caption text-[var(--ink-tertiary)]">
                    {l.domain}
                    {l.shareCount > 1 && ` · 被分享 ${l.shareCount} 次`}
                  </p>
                </div>
              </Row>
            ))}
          </Group>
        </Section>
      )}

      {/*
        出口。

        补课包不是目的地 —— 看完这一页该知道下一步去哪。
        没有这几个口子的话，人读完只会退回首页。
      */}
      <div className="flex flex-wrap gap-2 px-1">
        <Exit href={`/archive?group=${encodeURIComponent(pack.convId)}`}>按天翻这个群</Exit>
        <Exit href="/search">搜以前说过的话</Exit>
        <Exit href="/forum">去论坛开个话题</Exit>
      </div>
    </section>
  );
}

function Exit({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="tap-target t-caption inline-flex items-center rounded-full bg-[var(--fill)] px-3 py-1.5 text-[var(--ink-secondary)] transition-colors hover:bg-[var(--fill-strong)]"
    >
      {children}
    </Link>
  );
}
