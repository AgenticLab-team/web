import { ArrowUpRight, Bot } from "lucide-react";
import Link from "next/link";

import { Callout, Card, Empty } from "@/components/ui/primitives";
import type { AskResult, AnsweredSource } from "@/lib/search/rag";

/**
 * 群聊问答的结果。
 *
 * ─────────────────────────────────────────
 * 出处比答案本身重要
 * ─────────────────────────────────────────
 *
 * 一段总结会丢掉语气、前提和反对意见 —— 而群聊里那些恰恰是重点。
 * 所以引用不是脚注：每一条都摊开显示原话，并且能一步点回归档里
 * 那一刻的现场。
 *
 * 界面上必须一眼看出这段话是机器写的（顶上那行「机器整理」）。
 * 资源库那边给 AI 简介定的规矩是一样的：一个语气笃定的段落，
 * 人默认它是可靠的，得让他知道来源。
 */
export function RagAnswer({ result }: { result: AskResult }) {
  if (result.kind === "no-access") {
    return (
      <Empty
        title="你还不在任何一个已接入的群里"
        hint="群聊问答只在你自己所在的群里检索 —— 没有群就没有可问的东西。"
      />
    );
  }

  if (result.kind === "unavailable") {
    return (
      <Callout tone="warning" title="现在问不了">
        {/*
          说「问不了」而不是「没找到」。
          后者会让人以为群里没聊过，然后不再追问 ——
          而实际上是这一侧坏了，两者的下一步完全不同。
        */}
        <p className="t-caption mt-1 leading-relaxed text-[var(--ink-secondary)]">
          {result.reason}
        </p>
      </Callout>
    );
  }

  if (result.kind === "not-found") {
    return (
      <>
        <Empty
          title="群里没有聊过这件事"
          hint={result.reason}
          action={
            result.searched > 0 ? (
              <p className="t-caption text-[var(--ink-tertiary)]">
                （检索到 {result.searched} 段相关对话，但都答不上这个问题）
              </p>
            ) : undefined
          }
        />
        <Pending pending={result.pending} />
      </>
    );
  }

  return (
    <>
      <Card className="mb-3">
        <div className="mb-2 flex items-center gap-1.5 text-[var(--ink-tertiary)]">
          <Bot size={13} strokeWidth={2.2} aria-hidden />
          <span className="t-caption2">
            机器根据下面这几段群聊整理，可能有偏差 —— 点开出处看原话
          </span>
        </div>
        <p className="t-body leading-relaxed whitespace-pre-wrap">{result.answer}</p>
      </Card>

      <div className="space-y-2">
        {result.sources.map((source) => (
          <SourceCard key={source.index} source={source} />
        ))}
      </div>

      <Pending pending={result.pending} />
    </>
  );
}

/**
 * 一条出处。
 *
 * 原话直接摊开，不折叠 —— 折叠起来的话人不会去点，
 * 而这个功能的全部价值就在「你自己看」。
 */
function SourceCard({ source }: { source: AnsweredSource }) {
  const href = `/archive?group=${encodeURIComponent(source.convId)}&m=${encodeURIComponent(source.messageId)}`;

  return (
    <Card>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <p className="t-caption text-[var(--ink-secondary)]">
          <span className="text-[var(--accent)]">[{source.index}]</span>{" "}
          {source.groupName} · {source.date}
        </p>
        <Link
          href={href}
          className="t-caption inline-flex shrink-0 items-center gap-0.5 text-[var(--accent)]"
        >
          看现场
          <ArrowUpRight size={13} strokeWidth={2.2} aria-hidden />
        </Link>
      </div>

      <div className="space-y-1">
        {source.messages.map((m, i) => (
          <p key={i} className="t-caption leading-relaxed">
            <span className="text-[var(--ink-tertiary)]">{m.senderName}：</span>
            <span className="text-[var(--ink-secondary)]">{m.content}</span>
          </p>
        ))}
      </div>
    </Card>
  );
}

/**
 * 还有段落没嵌完时**如实说**。
 *
 * 不说的话，一个「没聊过」会被当成结论 ——
 * 而实际上可能只是那一段还没进索引。
 */
function Pending({ pending }: { pending: number }) {
  if (pending <= 0) return null;
  return (
    <p className="t-caption mt-3 px-1 text-[var(--ink-tertiary)]">
      还有 {pending} 段对话没进索引，这次的回答可能不完整。
    </p>
  );
}
