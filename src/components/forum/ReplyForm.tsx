"use client";

import { X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import { Editor } from "@/components/forum/Editor";
import { createReply } from "@/lib/forum/actions";

import { useQuote } from "./QuoteContext";

export function ReplyForm({ postId, locked }: { postId: string; locked: boolean }) {
  const router = useRouter();
  const quoteCtx = useQuote();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [key, setKey] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const quote = quoteCtx?.quote ?? null;

  // 点了某楼的「引用」之后把回复框滚进视野 ——
  // 长帖里回复框在几屏之外，不滚过去用户会以为点了没反应
  useEffect(() => {
    if (quote) rootRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [quote]);

  if (locked) {
    return (
      <div className="inset-group px-4 py-5 text-center">
        <p className="t-subhead text-[var(--ink-secondary)]">该帖已锁定，不能再回复</p>
      </div>
    );
  }

  const submit = () => {
    if (!content.trim()) return;
    setError(null);
    startTransition(async () => {
      const result = await createReply({
        postId,
        content,
        quotedReplyId: quote?.replyId,
      });
      if (!result.ok) {
        setError(result.error ?? "回复失败");
        return;
      }
      localStorage.removeItem(`draft:reply:${postId}`);
      setContent("");
      quoteCtx?.clearQuote();
      // 换掉 key 让编辑器重建，清空内容且不残留草稿
      setKey((k) => k + 1);
      router.refresh();
    });
  };

  return (
    <div ref={rootRef} className="space-y-3">
      {quote && (
        <div className="flex items-center gap-2 rounded-[var(--radius-control)] bg-[var(--accent-soft)] px-3 py-2">
          <p className="t-footnote min-w-0 flex-1 truncate text-[var(--accent)]">
            引用 #{quote.floor} · {quote.authorName}
          </p>
          <button
            type="button"
            aria-label="取消引用"
            onClick={() => quoteCtx?.clearQuote()}
            className="tap-target shrink-0 rounded-full p-1 text-[var(--accent)] transition hover:bg-[var(--accent)]/10 active:scale-90"
          >
            <X className="h-3.5 w-3.5" strokeWidth={2.2} aria-hidden />
          </button>
        </div>
      )}

      <Editor
        key={key}
        name="reply"
        draftKey={`reply:${postId}`}
        minHeight={110}
        placeholder={quote ? `回复 #${quote.floor}…` : "写下你的回复…"}
        onValueChange={setContent}
        onSubmit={submit}
      />

      {error && (
        <p className="t-footnote text-[var(--danger)]" role="alert">
          {error}
        </p>
      )}

      <button
        type="button"
        disabled={pending || !content.trim()}
        onClick={submit}
        className="t-body w-full rounded-[var(--radius-control)] bg-[var(--accent)] px-6 py-2.5 font-medium text-[var(--accent-ink)] transition active:scale-[0.98] disabled:opacity-40"
      >
        {pending ? "发送中…" : quote ? `回复 #${quote.floor}` : "回复"}
      </button>
    </div>
  );
}
