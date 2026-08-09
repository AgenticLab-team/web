"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";

import { Avatar } from "@/components/Avatar";
import { PersonLink } from "@/components/PersonLink";
import { relativeTime } from "@/components/forum/PostList";
import { messageLink } from "@/lib/messages/archive-rules";
import { loadContext } from "@/lib/search/actions";
import type { ContextMessage, MessageHit } from "@/lib/search/messages";

/**
 * 检索结果。
 *
 * 搜索结果只有一句话往往看不懂 —— 群聊的意思大半在上下文里。
 * 所以每条都能**就地展开**前后文，而不是跳走再跳回来：
 * 跳转会丢失滚动位置，翻十条结果就要翻十次页。
 */
export function MessageHitList({ hits }: { hits: MessageHit[] }) {
  return (
    <div className="inset-group">
      {hits.map((hit) => (
        <HitRow key={hit.id} hit={hit} />
      ))}
    </div>
  );
}

function HitRow({ hit }: { hit: MessageHit }) {
  const [expanded, setExpanded] = useState(false);
  const [context, setContext] = useState<ContextMessage[] | null>(null);
  const [pending, startTransition] = useTransition();

  const toggle = () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    // 已经取过就不再请求 —— 反复展开收起不该反复打服务器
    if (context) return;
    startTransition(async () => {
      const result = await loadContext(hit.id);
      setContext(result?.messages ?? []);
    });
  };

  return (
    <div className="inset-row">
      {/*
        * 头像挪到展开按钮**外面**。
        *
        * 整行原来是一个 <button>，而 <button> 里不能放 <a> ——
        * 嵌进去在部分浏览器上直接失效，键盘遍历顺序也会乱。
        * 所以头像单独站出来，剩下的仍然是「点一下展开上下文」。
        */}
      <div className="flex px-4 py-3 transition-colors hover:bg-[var(--fill)]">
        <PersonLink wxId={hit.senderWxId} name={hit.senderName} className="mr-3 shrink-0">
          <Avatar
            wxId={hit.senderWxId}
            name={hit.senderName}
            src={hit.avatarUrl}
            size={32}
            className="mt-0.5"
          />
        </PersonLink>
        <button
          type="button"
          onClick={toggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 gap-3 text-left"
        >
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="t-subhead font-medium">{hit.senderName}</span>
            <span className="t-caption text-[var(--ink-tertiary)]">{hit.groupName}</span>
            <span className="tabular t-caption text-[var(--ink-quaternary)]">
              {relativeTime(hit.ts)}
            </span>
          </span>
          <span
            className="t-subhead search-snippet mt-1 block leading-relaxed"
            dangerouslySetInnerHTML={{ __html: hit.snippet }}
          />
        </span>
        <span className="mt-1 shrink-0 text-[var(--ink-quaternary)]">
          {expanded ? (
            <ChevronUp className="h-4 w-4" strokeWidth={2} aria-hidden />
          ) : (
            <ChevronDown className="h-4 w-4" strokeWidth={2} aria-hidden />
          )}
        </span>
        </button>
      </div>

      {expanded && (
        <div className="animate-fade border-t border-[var(--separator)] bg-[var(--surface-sunken)] px-4 py-3">
          {pending && !context ? (
            <p className="t-caption text-[var(--ink-tertiary)]">正在取上下文…</p>
          ) : context && context.length > 0 ? (
            <ul className="space-y-2">
              {context.map((message) => (
                <li
                  key={message.id}
                  className={`flex gap-2 rounded-[var(--radius-control)] px-2 py-1.5 ${
                    message.isTarget ? "bg-[var(--accent-soft)]" : ""
                  }`}
                >
                  <span className="t-caption w-16 shrink-0 truncate text-[var(--ink-tertiary)]">
                    {message.senderName}
                  </span>
                  <span className="t-caption min-w-0 flex-1 whitespace-pre-wrap break-words leading-relaxed">
                    {message.type === "text" || message.type === "quote"
                      ? message.content
                      : `[${message.type}]`}
                  </span>
                  <span className="tabular t-caption2 shrink-0 text-[var(--ink-quaternary)]">
                    {new Date(message.ts).toLocaleTimeString("zh-CN", {
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                    })}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="t-caption text-[var(--ink-tertiary)]">取不到上下文</p>
          )}

          {/*
            * 就地看前后各 8 条解决大部分情况，但「我想看这条前后那半小时」
            * 只能去回看页。以前从搜索结果没有任何路能过去 ——
            * 人得自己记住日期，再去按天翻，再在几千条里找回这一条。
            */}
          <Link
            href={messageLink(hit.id, { convId: hit.convId })}
            prefetch={false}
            className="t-caption2 mt-2 inline-block text-[var(--accent)] transition active:opacity-60"
          >
            在群聊记录里打开这一条 →
          </Link>
        </div>
      )}
    </div>
  );
}
