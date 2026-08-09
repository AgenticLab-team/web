import { ExternalLink, Link2, ThumbsUp } from "lucide-react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { relativeTime } from "@/components/forum/PostList";
import { SaveButton } from "@/components/links/SaveButton";
import { VoteButton } from "@/components/links/VoteButton";
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
import { getCurrentUser } from "@/lib/auth/session";
import { listLinks } from "@/lib/links/queries";

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
  if (!user) redirect("/login?next=/links");

  const params = await searchParams;
  const savedOnly = params.saved === "1";
  const byVotes = params.sort === "votes";
  const result = listLinks(user, {
    domain: params.d,
    q: params.q,
    savedOnly,
    sort: byVotes ? "votes" : "recent",
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
            * 排序放在筛选之前。
            *
            * 「最有用」是这个页面真正的价值 —— 两百条链接里
            * 真正值得看的就那么十几条,而只有点赞数能把它们浮上来。
            * 按时间排只回答「最近有人分享什么」，那是另一个问题。
            */}
          <PillRow wrap>
            <Pill href={query({ sort: undefined })} active={!byVotes}>
              最近分享
            </Pill>
            <Pill href={query({ sort: "votes" })} active={byVotes}>
              <span className="flex items-center gap-1">
                <ThumbsUp className="h-3 w-3" strokeWidth={2.2} aria-hidden />
                最有用
              </span>
            </Pill>
          </PillRow>

          <PillRow>
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
                            */}
                          <span className="min-w-0 break-all">{item.aiTitle ?? item.title}</span>
                          <ExternalLink
                            className="h-3 w-3 shrink-0 translate-y-px text-[var(--ink-quaternary)]"
                            strokeWidth={2.2}
                            aria-hidden
                          />
                        </a>

                        {item.aiSummary ? (
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
                          {item.aiTitle && item.title !== item.aiTitle ? `${item.title} · ` : ""}
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
