import { Sparkles, TextQuote } from "lucide-react";
import Link from "next/link";

import { ShareSheet } from "@/components/share/ShareSheet";
import { messageLink } from "@/lib/messages/archive-rules";
import type { SemanticHit } from "@/lib/search/semantic";

/**
 * 语义检索的结果。
 *
 * ─────────────────────────────────────────
 * 一条结果是**一段对话**，不是一句话
 * ─────────────────────────────────────────
 *
 * 关键词检索命中的是某一句，展开前后文只是锦上添花。
 * 语义检索命中的本来就是一整段 —— 它之所以能匹配上，
 * 靠的正是那几句话合起来的意思。
 *
 * 所以整段一起显示，而不是挑一句出来 ——
 * 挑出来的那句往往单独看毫无意义（群聊里一半的消息不到 8 个字），
 * 人会以为搜错了。
 */
function time(ms: number) {
  return new Date(ms).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function SemanticHits({
  hits,
  siteUrl,
  canQuote = false,
}: {
  hits: SemanticHit[];
  siteUrl: string;
  /** 论坛开着时才给「引用」—— 关掉的话那个入口点进去是个 404 */
  canQuote?: boolean;
}) {
  return (
    <ul className="space-y-3">
      {hits.map((hit) => (
        <li key={hit.windowId} className="rounded-[var(--radius-card)] bg-[var(--surface)] p-4 hairline">
          <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="t-caption font-medium text-[var(--ink-secondary)]">{hit.groupName}</span>
            <span className="t-caption2 text-[var(--ink-quaternary)]">
              {time(hit.startTs)} · {hit.messages.length} 条
            </span>
            {/*
              * 相似度显示出来。
              *
              * 语义检索**总能**算出个最相似的，哪怕毫不相干 ——
              * 让人看见分数，他就能自己判断这条值不值得看，
              * 而不是默认排在第一位的就是对的。
              */}
            <span
              className="t-caption2 ml-auto tabular-nums text-[var(--ink-quaternary)]"
              title="语义相似度，越高越接近你要找的意思"
            >
              {(hit.score * 100).toFixed(0)}% 接近
            </span>

            {/*
              * 分享这一段。
              *
              * 图上**不会有群名** —— 「这条消息来自哪个群」比消息本身
              * 敏感得多。链接指回检索页，而检索页是有权限的。
              */}
            <ShareSheet
              url={`${siteUrl}/search`}
              text={`一段群聊记录\n${hit.messages[0]?.content?.slice(0, 40) ?? ""}\n${siteUrl}/search\n—— Agentic Lab`}
              imageUrl={`/api/share/window/${hit.windowId}/card`}
              label="转发"
            />
          </div>

          <div className="space-y-1">
            {hit.messages.map((m) => (
              <p key={m.id} className="t-subhead leading-relaxed">
                <span className="text-[var(--ink-tertiary)]">{m.senderName}：</span>
                <span className="text-[var(--ink)]">{m.content}</span>
              </p>
            ))}
          </div>

          {/*
            * 出口。
            *
            * 语义检索一直**没有任何一条路通向那段消息本身** ——
            * 看到一段觉得有用的对话，只能自己记住群名和时间，
            * 再去按天回看里翻。而这一页存在的理由就是「找到它」。
            *
            * 锚在这一段的**第一条**上：段是模型切出来的，
            * 而人要读的是从头读。
            */}
          {first(hit) && (
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 hairline-t pt-2">
              <Link
                href={messageLink(first(hit)!.id, { convId: hit.convId })}
                prefetch={false}
                className="t-caption2 text-[var(--accent)] transition active:opacity-60"
              >
                在群聊记录里打开这一段 →
              </Link>

              {canQuote && (
                <Link
                  href={messageLink(first(hit)!.id, { convId: hit.convId }, "/forum/convert")}
                  prefetch={false}
                  aria-label="引用这一段去整理成帖子"
                  className="tap-target t-caption2 inline-flex items-center gap-1 text-[var(--ink-tertiary)] transition-colors hover:text-[var(--accent)] active:text-[var(--accent)]"
                >
                  <TextQuote className="h-3 w-3" strokeWidth={2} aria-hidden />
                  引用这一段
                </Link>
              )}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

/** 语义检索没跑起来时的说明 —— 不能显示成「没搜到」 */
/** 这一段的第一条 —— 段是模型切出来的，而人要读的是从头读 */
function first(hit: SemanticHit) {
  return [...hit.messages].sort((a, b) => a.ts - b.ts)[0];
}

export function SemanticNotice({ error, pending }: { error: string | null; pending: number }) {
  if (!error && pending === 0) return null;

  return (
    <div
      role={error ? "alert" : "status"}
      className={`mb-3 flex items-start gap-1.5 rounded-lg border px-3 py-2 ${
        error
          ? "border-[var(--danger)]/40 bg-[var(--danger)]/8 text-[var(--danger)]"
          : "border-[var(--separator)] text-[var(--ink-tertiary)]"
      }`}
    >
      <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={2} aria-hidden />
      <p className="t-caption leading-relaxed">
        {error ??
          `还有 ${pending} 段对话没建好索引，这次的结果不完整 —— 建好之前搜不到那部分。`}
      </p>
    </div>
  );
}
