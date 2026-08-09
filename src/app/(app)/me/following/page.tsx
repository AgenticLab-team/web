import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { FollowList } from "@/components/forum/FollowList";
import { PageHeader } from "@/components/shell/PageHeader";
import { BackLink, PageNote, Section } from "@/components/ui/primitives";
import { getCurrentUser } from "@/lib/auth/session";
import { listFollows } from "@/lib/forum/follow";
import { MAX_FOLLOWS, TARGET_LABEL, type FollowTarget } from "@/lib/forum/follow-rules";

export const metadata: Metadata = { title: "我关注的" };
export const dynamic = "force-dynamic";

/**
 * 我关注的作者 / 版块 / 标签。
 *
 * ─────────────────────────────────────────
 * 只有自己看得到
 * ─────────────────────────────────────────
 *
 * 这一页没有「看某某关注了谁」的形态，查询层也没有那个签名 ——
 * 关注列表是一张社交图，而这个站的成员目录只对同群的人开放。
 * 一份能被别人打开的关注列表，是群成员名单之外的第二层隐私，
 * 而且没有人预期它是公开的。
 *
 * 同理不给被关注的人发「有人关注了你」：那条通知泄露的是同一件事。
 */
export default async function FollowingPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const items = listFollows(user.id);
  const counts = items.reduce<Record<string, number>>((acc, item) => {
    acc[item.target] = (acc[item.target] ?? 0) + 1;
    return acc;
  }, {});

  const used = (Object.keys(MAX_FOLLOWS) as FollowTarget[])
    .filter((t) => (counts[t] ?? 0) > 0)
    .map((t) => `${TARGET_LABEL[t]} ${counts[t]}/${MAX_FOLLOWS[t]}`)
    .join(" · ");

  return (
    <>
      <BackLink href="/me">我的</BackLink>

      <PageHeader
        title="我关注的"
        subtitle={items.length === 0 ? "还没关注任何人" : used}
      />

      <Section>
        <FollowList items={items} />
      </Section>

      <PageNote>
        他们发新帖时会给你一条通知，同一个来源的新帖会合并成一条 ——
        关注一个活跃版块不会变成一天十几次提醒。
        嫌吵可以在「通知设置 → 你关注的」里单独关掉这一类。
        <br />
        只有你自己看得到这份列表，被关注的人也不会收到任何提示。
      </PageNote>
    </>
  );
}
