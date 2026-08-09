"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Editor } from "@/components/forum/Editor";
import { createPost } from "@/lib/forum/actions";
import { EMPTY_POLL, PollComposer, type PollDraft } from "./PollComposer";

export interface BoardOption {
  key: string;
  name: string;
  description: string | null;
  maxVisibility: string;
}

const TYPES = [
  { key: "discussion", label: "讨论" },
  { key: "question", label: "提问" },
  { key: "showcase", label: "展示" },
  { key: "poll", label: "投票" },
] as const;

export function ComposeForm({
  boards,
  defaultBoard,
}: {
  boards: BoardOption[];
  defaultBoard?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [boardKey, setBoardKey] = useState(defaultBoard ?? boards[0]?.key ?? "");
  const [type, setType] = useState<(typeof TYPES)[number]["key"]>("discussion");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  /*
   * 投票草稿一直留着，即使切回「讨论」。
   *
   * 切走就清掉的话，人点错一下类型、填好的四个选项全没了 ——
   * 而那种丢失没有任何提示，只能重填。
   */
  const [poll, setPoll] = useState<PollDraft>(EMPTY_POLL);

  const board = boards.find((b) => b.key === boardKey);

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const result = await createPost({
        boardKey,
        title,
        content,
        // 投票帖的类型由服务端按有没有 poll 定 —— 两处各判一次迟早对不上
        type: type === "poll" ? "discussion" : type,
        poll:
          type === "poll"
            ? {
                question: poll.question,
                options: poll.options,
                multi: poll.multi,
                hideUntilVoted: poll.hideUntilVoted,
                // datetime-local 给的是本地时间字符串，转成毫秒再传
                closesAt: poll.closesAt ? new Date(poll.closesAt).getTime() : undefined,
              }
            : undefined,
      });
      if (!result.ok) {
        // 失败时绝不清空内容 —— 写了两千字被清掉就再也不会有人在这写东西
        setError(result.error ?? "发布失败");
        return;
      }
      localStorage.removeItem(`draft:new:${boardKey}`);
      router.push(`/forum/p/${result.postId}`);
    });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="space-y-4"
    >
      <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
        {boards.map((b) => (
          <button
            key={b.key}
            type="button"
            onClick={() => setBoardKey(b.key)}
            className={`t-footnote shrink-0 rounded-[var(--radius-pill)] px-3 py-1.5 font-medium transition-colors ${
              b.key === boardKey
                ? "bg-[var(--ink)] text-[var(--canvas)]"
                : "bg-[var(--fill)] text-[var(--ink-secondary)]"
            }`}
          >
            {b.name}
          </button>
        ))}
      </div>

      <div className="flex gap-1.5">
        {TYPES.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setType(t.key)}
            className={`t-footnote rounded-[var(--radius-pill)] px-3 py-1.5 transition-colors ${
              t.key === type
                ? "bg-[var(--accent-soft)] font-medium text-[var(--accent)]"
                : "text-[var(--ink-tertiary)] hover:bg-[var(--fill)]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="标题"
        maxLength={120}
        className="t-title3 w-full rounded-[var(--radius-card)] bg-[var(--surface)] px-4 py-3.5 outline-none hairline placeholder:text-[var(--ink-quaternary)]"
      />

      {/*
        * 投票编辑器排在正文**上面**。
        *
        * 选了「投票」之后，人接下来要填的就是选项 ——
        * 放在正文下面的话，写完两千字才发现下面还有一块要填。
        */}
      {type === "poll" && <PollComposer value={poll} onChange={setPoll} />}

      <Editor
        name="content"
        draftKey={`new:${boardKey}`}
        minHeight={280}
        placeholder="正文…支持 Markdown、代码块、@提及"
        onValueChange={setContent}
        onSubmit={submit}
      />

      {board && (
        <p className="t-caption px-1 leading-relaxed text-[var(--ink-tertiary)]">
          发到「{board.name}」
          {board.maxVisibility === "group"
            ? " · 该版块内容只有原群成员可见"
            : board.maxVisibility === "member"
              ? " · 该版块内容仅登录成员可见"
              : " · 该版块内容对所有人可见"}
        </p>
      )}

      {error && (
        <p className="t-footnote rounded-[var(--radius-control)] bg-[var(--danger)]/10 px-3 py-2.5 text-[var(--danger)]" role="alert">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending || !title.trim() || !content.trim()}
          className="t-body flex-1 rounded-[var(--radius-control)] bg-[var(--accent)] px-6 py-3 font-medium text-[var(--accent-ink)] transition active:scale-[0.98] disabled:opacity-40"
        >
          {pending ? "发布中…" : "发布"}
        </button>
        <button
          type="button"
          onClick={() => router.back()}
          className="t-body rounded-[var(--radius-control)] bg-[var(--fill)] px-5 py-3 transition active:scale-[0.98]"
        >
          取消
        </button>
      </div>
    </form>
  );
}
