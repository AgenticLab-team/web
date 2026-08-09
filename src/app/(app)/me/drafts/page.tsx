import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { DraftList } from "@/components/forum/DraftList";
import { ScheduledList } from "@/components/forum/ScheduledList";
import { PageHeader } from "@/components/shell/PageHeader";
import { BackLink, PageNote, Section } from "@/components/ui/primitives";
import { getCurrentUser } from "@/lib/auth/session";
import { buildViewerContext } from "@/lib/forum/context";
import { listDrafts } from "@/lib/forum/drafts";
import { listScheduled } from "@/lib/forum/schedule";
import { scheduleNote } from "@/lib/forum/schedule-rules";
import { listBoards } from "@/lib/forum/queries";

export const metadata: Metadata = { title: "草稿箱" };
export const dynamic = "force-dynamic";

/**
 * 草稿箱。
 *
 * ─────────────────────────────────────────
 * 只有本人看得到，管理员也不行
 * ─────────────────────────────────────────
 *
 * 草稿是**还没发表的东西**。已发表的内容有可见性规则、有版主、
 * 有审计；草稿一样都没有 —— 它甚至可能是一句写到一半就决定不发的话。
 *
 * 所以查询层里没有任何「按 id 取草稿」的签名（见 lib/forum/drafts.ts），
 * 后台也没有任何地方能把它渲染出来。
 */
function subtitleOf(drafts: number, scheduled: number): string {
  const parts: string[] = [];
  if (scheduled > 0) parts.push(`${scheduled} 篇等着发`);
  if (drafts > 0) parts.push(`${drafts} 份没写完`);
  return parts.length === 0 ? "没有写到一半的东西" : parts.join(" · ");
}

export default async function DraftsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const items = listDrafts(user.id);
  const scheduled = listScheduled(user.id);
  const viewer = buildViewerContext(user);
  // 帖子草稿的 targetId 是版块 key，翻成名字才认得出是哪一篇
  const boardNames = Object.fromEntries(listBoards(viewer).map((b) => [b.key, b.name]));

  return (
    <>
      <BackLink href="/me">我的</BackLink>

      <PageHeader
        title="草稿箱"
        subtitle={subtitleOf(items.length, scheduled.length)}
      />

      {/*
        * 「等着发的」排在前面 —— 它是有截止时间的那一类。
        *
        * 这两节是两码事，标题和措辞都分开：
        * 上面是**写完了在等时间**，下面是**还没写完**。
        * 混在一起的话，人会以为定时的那些也要自己再点一次发布。
        */}
      {scheduled.length > 0 && (
        <Section title={`等着发的（${scheduled.length}）`}>
          <ScheduledList items={scheduled} />
          <PageNote>{scheduleNote()}</PageNote>
        </Section>
      )}

      <Section title={scheduled.length > 0 ? "还没写完的" : undefined}>
        <DraftList items={items} boardNames={boardNames} />
      </Section>

      <PageNote>
        写在发帖框和回复框里的内容会自动存一份到服务器，换设备接着写。
        微信里页面被系统回收之前也会抢存一次。
        <br />
        只有你自己看得到草稿箱 —— 草稿是还没发表的东西，管理员也翻不到。
      </PageNote>
    </>
  );
}
