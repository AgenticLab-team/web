import { MessageCircleQuestion, Sparkles, User } from "lucide-react";
import { requireFeature } from "@/lib/flags/server";
import type { Metadata } from "next";
import { Suspense } from "react";

import { MessageHitList } from "@/components/search/MessageHitList";
import { featureEnabled } from "@/lib/flags/server";
import { SemanticHits, SemanticNotice } from "@/components/search/SemanticHits";
import { ChatTabs } from "@/components/shell/ChatTabs";
import { RagAnswer } from "@/components/search/RagAnswer";
import { PageHeader } from "@/components/shell/PageHeader";
import {
  Empty,
  EmptyAction,
  PageNote,
  Pill,
  PillRow,
  SearchField,
} from "@/components/ui/primitives";
import { CardListSkeleton } from "@/components/ui/Skeleton";
import { getCurrentUser, type CurrentUser } from "@/lib/auth/session";
import { visibleGroupsFor } from "@/lib/queries/visibility";
import { myMessageCount, searchMessages } from "@/lib/search/messages";
import { askGroups } from "@/lib/search/rag";
import { semanticSearch } from "@/lib/search/semantic";
import { env } from "@/lib/env";

export const metadata: Metadata = { title: "检索" };
export const dynamic = "force-dynamic";

/**
 * 群消息检索。
 *
 * 微信自己的搜索烂到没法用 —— 半年前的内容等于不存在。
 * 45,000 条消息里埋着这个社区全部的价值，这个页面就是把它们挖出来。
 */
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    group?: string;
    mine?: string;
    from?: string;
    to?: string;
    /** 「意思差不多的」—— 语义检索，走嵌入而不是分词 */
    mode?: string;
  }>;
}) {
  const params = await searchParams;
  const user = await getCurrentUser();
  // 功能开关：关掉之后这一页 404 —— 只藏导航的话，地址栏敲一下照样进得去
  requireFeature("message_search", user);
  const groups = visibleGroupsFor(user);
  const query = (params.q ?? "").trim();
  const onlyMine = params.mine === "1";

  const semantic = params.mode === "semantic";
  /*
   * 问答挂在同一个搜索框下面，作为第三档。
   *
   * 单开一页的话，人得先知道它存在才会去 —— 而「群里聊过 X 吗」
   * 和「搜 X」本来就是同一个念头的两种说法。放在一起，
   * 关键词搜不到的时候顺手换一档就试了。
   *
   * 开关关掉时这一档直接不存在（不是点了没反应）——
   * 一个点了没反应的标签比没有这个标签糟。
   */
  const canAsk = featureEnabled("rag_qa", user);
  const asking = canAsk && params.mode === "ask";

  const result = searchMessages(user, {
    query,
    convId: params.group,
    onlyMine,
    from: params.from,
    to: params.to,
    limit: 50,
  });

  const href = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams();
    const merged = {
      q: query,
      group: params.group,
      mine: onlyMine ? "1" : undefined,
      mode: semantic ? "semantic" : undefined,
      ...patch,
    };
    for (const [key, value] of Object.entries(merged)) {
      if (value) next.set(key, value);
    }
    const qs = next.toString();
    return qs ? `/search?${qs}` : "/search";
  };

  const mineCount = myMessageCount(user);

  return (
    <>
      <PageHeader
        title="检索"
        subtitle={
          query
            ? `“${query}” · ${result.total} 条结果`
            : `在你所在的 ${groups.length} 个群里搜`
        }
      />

      <ChatTabs current="search" />

      <form action="/search" className="mb-4">
        {params.group && <input type="hidden" name="group" value={params.group} />}
        {onlyMine && <input type="hidden" name="mine" value="1" />}
        <SearchField
          defaultValue={query}
          placeholder="搜群聊记录，两个字也搜得到"
          autoFocus={!query}
        />
      </form>

      {groups.length > 0 && (
        <PillRow>
          <Pill href={href({ group: undefined })} active={!params.group}>
            全部群
          </Pill>
          {groups.map((g) => (
            <Pill key={g.convId} href={href({ group: g.convId })} active={params.group === g.convId}>
              {g.name}
            </Pill>
          ))}
        </PillRow>
      )}

      {/*
        * 两种搜法并排放，而不是藏在设置里。
        *
        * 「关键词」和「意思差不多的」解决的是不同的问题:
        * 记得原话用前者,只记得当时在聊什么用后者。
        * 藏起来的话没有人会发现第二种存在。
        */}
      <PillRow wrap>
        <Pill href={href({ mode: undefined })} active={!semantic}>
          按关键词
        </Pill>
        <Pill href={href({ mode: "semantic" })} active={semantic}>
            <Sparkles className="h-3 w-3" strokeWidth={2.2} aria-hidden />
            意思差不多的
        </Pill>
        {canAsk && (
          <Pill href={href({ mode: "ask" })} active={asking}>
            <MessageCircleQuestion className="h-3 w-3" strokeWidth={2.2} aria-hidden />
            问一句
          </Pill>
        )}
      </PillRow>

      <PillRow wrap>
        <Pill href={href({ mine: onlyMine ? undefined : "1" })} active={onlyMine}>
            <User className="h-3 w-3" strokeWidth={2.2} aria-hidden />
            只搜我说过的
        </Pill>
        {/*
          * 原来这里还有一颗「按天回看」——
          * 它是当初按天回看根本不在导航里时留的一条小路。
          * 现在它和检索同属「群聊」，在页顶那一排里，这里就是重复了。
          */}
      </PillRow>

      {result.noAccess ? (
        <Empty
          title="群聊检索仅对社群成员开放"
          action={<EmptyAction href="/login">登录</EmptyAction>}
        />
      ) : !query ? (
        <Empty
          title={
            asking
              ? "问一句，比如「群里聊过怎么部署吗」"
              : semantic
                ? "描述一下当时在聊什么"
                : "输入关键词开始搜"
          }
          hint={
            asking
              ? "只在你所在的群里检索，答案后面会附上原话出处 —— 群里没聊过就直说没聊过"
              : semantic
              ? "不用记得原话 —— 「有人推荐过的那个部署工具」这种说法也搜得到"
              : mineCount > 0
                ? `你在群里说过 ${mineCount.toLocaleString("zh-CN")} 条，试试搜自己说过的话`
                : "只会搜到你所在群的内容"
          }
        />
      ) : asking ? (
        /*
         * 问答比语义检索还慢：一次嵌入 + 一次对话补全，
         * 最坏情况几十秒。同样挂 Suspense，让搜索框先到。
         * key 带上 mode —— 只用 query 的话，同一个词在两档之间
         * 切换不会重新挂起，会拿另一档的旧结果充数。
         */
        <Suspense key={`ask:${query}`} fallback={<CardListSkeleton cards={3} avatar={false} />}>
          <AskResults user={user} query={query} />
        </Suspense>
      ) : semantic ? (
        /*
         * 语义检索要打一次嵌入接口（几百毫秒，超时上限 20 秒）。
         * 以前整页 render 等它 —— 嵌入服务一抖，搜索页就整个卡住。
         * 挂进 Suspense 之后，搜索框和筛选先到，结果流式补上；
         * key 用 query：换词重搜必须重新挂起，否则会拿旧结果充数。
         */
        <Suspense key={query} fallback={<CardListSkeleton cards={3} avatar={false} />}>
          <SemanticResults user={user} query={query} />
        </Suspense>
      ) : result.hits.length === 0 ? (
        <Empty title="没有找到相关内容" hint="换个说法，或者试试更短的词" />
      ) : (
        <MessageHitList hits={result.hits} canQuote={featureEnabled("forum", user)} />
      )}

      <PageNote>
        只搜你所在的群。
        {semantic ? (
          <>
            「意思差不多的」按<strong>整段对话</strong>匹配，不是按单句 ——
            群聊里一半的消息不到 8 个字，单句拿去比对没有可检索性。
          </>
        ) : (
          <>点开任意一条可以就地看前后文 —— 群聊的意思大半在上下文里。</>
        )}
      </PageNote>
    </>
  );
}

/**
 * 问答结果。
 *
 * 和语义检索一样单独成组件挂 Suspense —— 它更慢（嵌入 + 对话两跳），
 * 整页等它的话，搜索框和筛选也一起卡住。
 */
async function AskResults({ user, query }: { user: CurrentUser | null; query: string }) {
  return <RagAnswer result={await askGroups(user, query)} />;
}

/** 语义检索结果。单独成组件是为了能挂在 Suspense 里流式送达 —— 见调用处 */
async function SemanticResults({ user, query }: { user: CurrentUser | null; query: string }) {
  const result = await semanticSearch(user, query, 12);

  return (
    <>
      <SemanticNotice error={result.error} pending={result.pending} />
      {result.hits.length > 0 ? (
        <SemanticHits
          hits={result.hits}
          siteUrl={env.site.url}
          canQuote={featureEnabled("forum", user)}
        />
      ) : (
        !result.error && (
          <Empty
            title="没找到意思接近的对话"
            hint="换个说法试试，或者切回「按关键词」"
          />
        )
      )}
    </>
  );
}
