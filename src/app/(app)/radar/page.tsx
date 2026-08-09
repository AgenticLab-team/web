import { Radar } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { RadarManager } from "@/components/radar/RadarManager";
import { PageHeader } from "@/components/shell/PageHeader";
import { Card, Section } from "@/components/ui/primitives";
import { requireFeature } from "@/lib/flags/server";
import { getCurrentUser } from "@/lib/auth/session";
import { visibleGroupsFor } from "@/lib/queries/visibility";
import { MAX_HITS_PER_DAY, MAX_KEYWORDS_PER_USER } from "@/lib/radar/match";
import { mySubs } from "@/lib/radar/queries";

export const metadata: Metadata = { title: "关键词雷达" };
export const dynamic = "force-dynamic";

/**
 * 关键词雷达。
 *
 * 群里的话流得很快，想等的那句往往在你没看的时候过去了。
 * 订阅几个词，有人提到就通知你。
 *
 * **只在你自己所在的群里匹配** —— 否则这就不是雷达，
 * 是一个能监听任意群的工具，而那个工具一旦存在，
 * 「我在哪个群」这件事就没有意义了。
 */
export default async function RadarPage() {
  const user = await getCurrentUser();
  // 功能开关：关掉之后这一页 404 —— 只藏导航的话，地址栏敲一下照样进得去
  requireFeature("keyword_radar", user);
  if (!user) redirect("/login?next=/radar");

  const subs = mySubs(user.id);
  const groups = visibleGroupsFor(user);

  return (
    <>
      <PageHeader
        title="关键词雷达"
        subtitle={
          subs.length === 0
            ? "群里提到你在意的词就通知你"
            : `${subs.length} 个词 · 累计命中 ${subs.reduce((n, s) => n + s.totalHits, 0)} 次`
        }
      />

      {groups.length === 0 ? (
        <Card>
          <p className="t-subhead">你还没有加入任何已接入的群</p>
          <p className="t-caption mt-1 leading-relaxed text-[var(--ink-tertiary)]">
            雷达只在你自己所在的群里匹配 —— 没有群就没有可扫的范围。
          </p>
        </Card>
      ) : (
        <Section>
          <RadarManager initial={subs} />
        </Section>
      )}

      <Section title="它怎么工作">
        <div className="inset-group">
          <Row
            title="只扫你在的群"
            body={`当前 ${groups.length} 个。别的群里说什么，雷达看不到也不会告诉你`}
          />
          <Row
            title="每个词每天最多提醒 5 次"
            body="超过之后当天不再打扰，但命中仍然记着 —— 列表上看得出「还在响，只是不通知了」，第二天重新开始"
          />
          <Row
            title="十分钟内不重复提醒"
            body="一串连续讨论不该变成一串连续通知"
          />
          <Row
            title="自己说的话不提醒自己"
            body="你发的消息里出现这个词不算命中"
          />
          <Row title={`最多订阅 ${MAX_KEYWORDS_PER_USER} 个词`} body="订阅之前会先告诉你这个词有多吵" />
        </div>
        <p className="t-caption mt-2 flex gap-1.5 px-1 leading-relaxed text-[var(--ink-tertiary)]">
          <Radar className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={2} aria-hidden />
          <span>
            嫌吵可以在
            <Link href="/me/notifications" className="text-[var(--accent)]">
              通知设置
            </Link>
            里把「关键词雷达命中」整类关掉，或者在上面把单个词暂停 ——
            暂停会保留已经攒下的命中记录。每天上限 {MAX_HITS_PER_DAY} 次。
          </span>
        </p>
      </Section>
    </>
  );
}

function Row({ title, body }: { title: string; body: string }) {
  return (
    <div className="inset-row px-4 py-2.5">
      <p className="t-subhead">{title}</p>
      <p className="t-caption mt-0.5 leading-relaxed text-[var(--ink-tertiary)]">{body}</p>
    </div>
  );
}
