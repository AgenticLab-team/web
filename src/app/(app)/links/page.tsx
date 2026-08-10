import { ExternalLink, Link2, ThumbsUp, Users } from "lucide-react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { relativeTime } from "@/components/forum/PostList";
import { SaveButton } from "@/components/links/SaveButton";
import { VoteButton } from "@/components/links/VoteButton";
import { ChatTabs } from "@/components/shell/ChatTabs";
import { PageHeader } from "@/components/shell/PageHeader";
import {
  Card,
  Empty,
  PageNote,
  Pill,
  PillRow,
  SearchField,
  Section,
} from "@/components/ui/primitives";
import { requireFeature } from "@/lib/flags/server";
import { getCurrentUser } from "@/lib/auth/session";
import { listLinks, type LinkSort } from "@/lib/links/queries";

export const metadata: Metadata = { title: "资源库" };
export const dynamic = "force-dynamic";

/**
 * 资源库。
 *
 * 群里每天都在扔链接，而微信里翻不到昨天的东西 ——
 * 这一页就是把那些链接从聊天流里捞出来、去重、排好。
 *
 * 两件事和成员目录同一条规矩：
 *   · 只显示**在你所在的群里被分享过**的链接
 *   · 分享者的名字显示（你本来就在那个群里看得到他），
 *     但**群名不显示** —— 说出来就等于泄露了另一个群的存在
 *
 * 还有一条不太显眼但重要的：「被分享 N 次」数的是**你看得到的那些次**。
 * 用全站次数的话，一条只在别的群火过的链接会显示「12 次」，
 * 而你在自己群里从没见过它 —— 那个数字本身就泄露了别处的热度。
 */
export default async function LinksPage({
  searchParams,
}: {
  searchParams: Promise<{ d?: string; q?: string; saved?: string; sort?: string }>;
}) {
  const user = await getCurrentUser();
  // 功能开关：关掉之后这一页 404 —— 只藏导航的话，地址栏敲一下照样进得去
  requireFeature("link_library", user);
  if (!user) redirect("/login?next=/links");

  const params = await searchParams;
  const savedOnly = params.saved === "1";
  /*
   * 默认按「多人分享」。
   *
   * 这一页是个**资源库**，不是时间线 —— 打开它的人要的是
   * 「这两百条里哪些值得看」，而不是「最近谁贴了什么」。
   * 后者一键就在旁边。
   */
  const bySort: LinkSort =
    params.sort === "votes" ? "votes" : params.sort === "recent" ? "recent" : "shares";
  const result = listLinks(user, {
    domain: params.d,
    q: params.q,
    savedOnly,
    sort: bySort,
  });

  const query = (over: Record<string, string | undefined>) => {
    const next = new URLSearchParams();
    const merged = { d: params.d, q: params.q, saved: params.saved, sort: params.sort, ...over };
    for (const [k, v] of Object.entries(merged)) if (v) next.set(k, v);
    const qs = next.toString();
    return qs ? `/links?${qs}` : "/links";
  };

  return (
    <>
      <PageHeader
        title="资源库"
        subtitle={
          result.total === 0
            ? "还没有收录到链接"
            : `${result.total} 条 · 来自你所在的群`
        }
      />

      <ChatTabs current="links" />

      {result.total === 0 ? (
        <Empty
          title="资源库是空的"
          hint="群里有人发链接之后会自动收录进来 —— 只收录你所在的群里出现过的"
        />
      ) : (
        <>
          <form action="/links" className="mb-3">
            {params.d && <input type="hidden" name="d" value={params.d} />}
            <SearchField defaultValue={params.q ?? ""} placeholder="搜标题、地址、说明" />
          </form>

          {/*
            * 排序和筛选合成一行。
            *
            * 原来是两排药丸各占一行，加上上面的搜索框就是**三行**壳子 ——
            * 在手机上，翻到第一条链接之前得先划过半屏的按钮。
            *
            * 两组做的是同一件事（把列表收窄），中间一道竖线就够分开了。
            * 排序仍然排在前面：「最有用」是这个页面真正的价值 ——
            * 两百条链接里值得看的就那么十几条。
            *
            * 而**只靠点赞浮不上来**：线上 213 条里被赞过的只有 2 条，
            * 于是那一档实际上是在按时间排。「有几个人在群里贴过它」
            * 这个信号一直就在数据里，不需要任何人动手 ——
            * 所以它是默认档。
            */}
          <PillRow>
            <Pill href={query({ sort: undefined })} active={bySort === "shares"}>
              <Users className="h-3 w-3" strokeWidth={2.2} aria-hidden />
              多人分享
            </Pill>
            <Pill href={query({ sort: "recent" })} active={bySort === "recent"}>
              最近分享
            </Pill>
            <Pill href={query({ sort: "votes" })} active={bySort === "votes"}>
                <ThumbsUp className="h-3 w-3" strokeWidth={2.2} aria-hidden />
                最有用
            </Pill>

            {/* 分组之间的竖线。aria-hidden —— 读屏念一条竖线没有意义 */}
            <span
              className="mx-0.5 h-4 w-px self-center bg-[var(--separator)]"
              aria-hidden
            />

            <Pill href={query({ d: undefined, saved: undefined })} active={!params.d && !savedOnly}>
              全部
            </Pill>
            {result.savedCount > 0 && (
              <Pill href={query({ saved: savedOnly ? undefined : "1" })} active={savedOnly}>
                我收藏的<span className="tabular ml-1 opacity-55">{result.savedCount}</span>
              </Pill>
            )}
            {result.facets.map((facet) => (
              <Pill
                key={facet.domain}
                href={query({ d: params.d === facet.domain ? undefined : facet.domain })}
                active={params.d === facet.domain}
              >
                {facet.label}
                <span className="tabular ml-1 opacity-55">{facet.count}</span>
              </Pill>
            ))}
          </PillRow>

          <Section>
            {result.items.length === 0 ? (
              <Empty
                title="没有符合的链接"
                hint={params.q ? `换个词试试 —— 「${params.q}」没有命中` : "换个筛选看看"}
              />
            ) : (
              <div className="space-y-2">
                {result.items.map((item) => (
                  <Card as="article" key={item.id}>
                    <div className="flex gap-2.5">
                      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--fill)]">
                        <Link2 className="h-4 w-4 text-[var(--ink-tertiary)]" strokeWidth={2} aria-hidden />
                      </span>

                      <div className="min-w-0 flex-1">
                        <a
                          href={item.url}
                          target="_blank"
                          rel="noopener noreferrer nofollow"
                          className="t-body inline-flex items-baseline gap-1 font-medium transition active:opacity-60"
                        >
                          {/*
                            * 有整理过的标题就用它 —— 原来那个多半只是域名。
                            * 但原文不丢:下面那行小字会把它带出来,
                            * 让人对得上「这条到底指向哪」。
                            *
                            * **来源给的排在模型前面**：GitHub 直接告诉我们
                            * 这个仓库叫什么，那不是猜的。
                            */}
                          <span className="min-w-0 break-all">
                            {item.factTitle ?? item.aiTitle ?? item.title}
                          </span>
                          <ExternalLink
                            className="h-3 w-3 shrink-0 translate-y-px text-[var(--ink-quaternary)]"
                            strokeWidth={2.2}
                            aria-hidden
                          />
                        </a>

                        {item.factSummary ? (
                          <p className="t-caption mt-0.5 leading-relaxed text-[var(--ink-secondary)]">
                            {item.factSummary}
                            {/*
                              * 这一份是**来源自己说的**，所以标的是出处，
                              * 不是「AI 整理」。
                              *
                              * 两种都标成机器写的话，那句提示就废了：
                              * 人看见它出现在一条明显准确的条目上，
                              * 下次真正机器写的那条出现时也不会再当回事。
                              */}
                            <span
                              className="ml-1 align-baseline text-[var(--ink-quaternary)]"
                              title="来自 GitHub 接口，不是模型整理的"
                            >
                              · 来自 GitHub
                            </span>
                          </p>
                        ) : item.aiSummary ? (
                          <p className="t-caption mt-0.5 leading-relaxed text-[var(--ink-secondary)]">
                            {item.aiSummary}
                            {/*
                              * 标出来是机器写的。
                              *
                              * 一段语气笃定、格式工整的简介,人默认它是可靠的 ——
                              * 而它是根据群里的只言片语整理出来的,可能不准。
                              * 不标的话,读的人没有机会自己判断要不要信。
                              */}
                            <span
                              className="ml-1 align-baseline text-[var(--ink-quaternary)]"
                              title="根据分享时群里的对话由模型整理，可能不准"
                            >
                              · AI 整理
                            </span>
                          </p>
                        ) : (
                          item.note && (
                            <p className="t-caption mt-0.5 leading-relaxed text-[var(--ink-secondary)]">
                              {item.note}
                            </p>
                          )
                        )}

                        <p className="t-caption2 mt-1 text-[var(--ink-quaternary)]">
                          {(() => {
                            // 上面显示的是哪一个，这里就把原文带出来对照
                            const shown = item.factTitle ?? item.aiTitle;
                            return shown && item.title !== shown ? `${item.title} · ` : "";
                          })()}
                          {item.domainLabel}
                          {item.sharers.length > 0 && ` · ${item.sharers.join("、")} 分享`}
                          {item.visibleShares > 1 && ` · 被分享 ${item.visibleShares} 次`}
                          {` · ${relativeTime(item.lastSharedAt)}`}
                        </p>
                      </div>

                      <VoteButton
                        linkId={item.id}
                        initialVoted={item.voted}
                        initialCount={item.voteCount}
                      />
                      <SaveButton linkId={item.id} initial={item.saved} />
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </Section>
        </>
      )}

      <PageNote>
        链接从群聊里自动收录，去掉了追踪参数并合并了重复的。
        <strong>只收录你所在的群里出现过的</strong>，而且不显示来自哪个群 ——
        「被分享 N 次」数的也只是你看得到的那些次。
      </PageNote>
    </>
  );
}
