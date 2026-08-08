import { Archive, Search as SearchIcon, User } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { MessageHitList } from "@/components/search/MessageHitList";
import { PageHeader } from "@/components/shell/PageHeader";
import { Empty, Pill } from "@/components/ui/primitives";
import { getCurrentUser } from "@/lib/auth/session";
import { visibleGroupsFor } from "@/lib/queries/visibility";
import { myMessageCount, searchMessages } from "@/lib/search/messages";
import { todayKey } from "@/lib/time";

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
  searchParams: Promise<{ q?: string; group?: string; mine?: string; from?: string; to?: string }>;
}) {
  const params = await searchParams;
  const user = await getCurrentUser();
  const groups = visibleGroupsFor(user);
  const query = (params.q ?? "").trim();
  const onlyMine = params.mine === "1";

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
    const merged = { q: query, group: params.group, mine: onlyMine ? "1" : undefined, ...patch };
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

      <form action="/search" className="mb-4">
        {params.group && <input type="hidden" name="group" value={params.group} />}
        {onlyMine && <input type="hidden" name="mine" value="1" />}
        <div className="flex items-center gap-2 rounded-[var(--radius-card)] bg-[var(--surface)] px-4 py-3 hairline">
          <SearchIcon
            className="h-4 w-4 shrink-0 text-[var(--ink-tertiary)]"
            strokeWidth={2}
            aria-hidden
          />
          <input
            name="q"
            defaultValue={query}
            placeholder="搜群聊记录，两个字也搜得到"
            autoFocus={!query}
            enterKeyHint="search"
            className="t-body w-full bg-transparent outline-none placeholder:text-[var(--ink-quaternary)]"
          />
        </div>
      </form>

      {groups.length > 0 && (
        <div className="-mx-4 mb-3 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:-mx-6 sm:px-6">
          <span className="shrink-0">
            <Pill href={href({ group: undefined })} active={!params.group}>
              全部群
            </Pill>
          </span>
          {groups.map((g) => (
            <span key={g.convId} className="shrink-0">
              <Pill href={href({ group: g.convId })} active={params.group === g.convId}>
                {g.name}
              </Pill>
            </span>
          ))}
        </div>
      )}

      <div className="mb-6 flex flex-wrap gap-1.5">
        <Pill href={href({ mine: onlyMine ? undefined : "1" })} active={onlyMine}>
          <span className="flex items-center gap-1">
            <User className="h-3 w-3" strokeWidth={2.2} aria-hidden />
            只搜我说过的
          </span>
        </Pill>
        <Pill href={`/archive?date=${todayKey()}`} active={false}>
          <span className="flex items-center gap-1">
            <Archive className="h-3 w-3" strokeWidth={2.2} aria-hidden />
            按天回看
          </span>
        </Pill>
      </div>

      {result.noAccess ? (
        <div className="inset-group px-6 py-10 text-center">
          <p className="t-callout text-[var(--ink-secondary)]">群聊检索仅对社群成员开放</p>
          <Link
            href="/login"
            className="t-subhead mt-5 inline-flex rounded-[var(--radius-control)] bg-[var(--accent)] px-5 py-2.5 font-medium text-[var(--accent-ink)]"
          >
            登录
          </Link>
        </div>
      ) : !query ? (
        <Empty
          title="输入关键词开始搜"
          hint={
            mineCount > 0
              ? `你在群里说过 ${mineCount.toLocaleString("zh-CN")} 条，试试搜自己说过的话`
              : "只会搜到你所在群的内容"
          }
        />
      ) : result.hits.length === 0 ? (
        <Empty title="没有找到相关内容" hint="换个说法，或者试试更短的词" />
      ) : (
        <MessageHitList hits={result.hits} />
      )}

      <p className="t-caption mt-4 px-1 leading-relaxed text-[var(--ink-tertiary)]">
        只搜你所在的群。点开任意一条可以就地看前后文 —— 群聊的意思大半在上下文里。
      </p>
    </>
  );
}
