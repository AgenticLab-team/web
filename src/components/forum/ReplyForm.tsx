"use client";

import { X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import { Editor } from "@/components/forum/Editor";
import { createReply } from "@/lib/forum/actions";
import type { DraftSnapshot } from "@/lib/forum/draft-rules";

import { DraftSync } from "./DraftSync";
import { clearLocalDraft } from "./local-draft";
import { useQuote } from "./QuoteContext";
import { useServerDraft } from "./use-server-draft";

export function ReplyForm({
  postId,
  locked,
  lockNotice = null,
  serverDraft = null,
}: {
  postId: string;
  locked: boolean;
  /**
   * 锁上之后显示哪一句。
   *
   * 「该帖已锁定」只说了发生什么，没说为什么 —— 而楼主收尾
   * 和版主叫停在读者眼里是完全不同的信号，用同一句话盖住
   * 等于把两件事混成一件。
   */
  lockNotice?: string | null;
  /** 服务端上那份写了一半的回复 */
  serverDraft?: DraftSnapshot | null;
}) {
  const router = useRouter();
  const quoteCtx = useQuote();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [key, setKey] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const quote = quoteCtx?.quote ?? null;

  /*
   * 回复框也存服务端。
   *
   * 长回复在微信里被回收掉的概率和长帖一样高，而回复框还多一层：
   * 它在页面底部，人写着写着上滑去翻别人说了什么，
   * 一切走就可能回不来了。
   */
  const sync = useServerDraft({
    target: "reply",
    scope: postId,
    title: null,
    content,
    serverUpdatedAt: serverDraft?.updatedAt ?? null,
    enabled: !locked,
  });

  const [restoreInto, setRestoreInto] = useState<string | null>(serverDraft?.content ?? null);

  // 点了某楼的「引用」之后把回复框滚进视野 ——
  // 长帖里回复框在几屏之外，不滚过去用户会以为点了没反应
  useEffect(() => {
    if (quote) rootRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [quote]);

  if (locked) {
    return (
      <div className="inset-group px-4 py-5 text-center">
        <p className="t-subhead text-[var(--ink-secondary)]">
          {lockNotice ?? "该帖已锁定"}
        </p>
        <p className="t-caption mt-1 text-[var(--ink-tertiary)]">不能再回复了</p>
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
      clearLocalDraft(`reply:${postId}`);
      setRestoreInto(null);
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
        restoreValue={restoreInto}
        onSubmit={submit}
      />

      <DraftSync
        saving={sync.saving}
        savedAt={sync.savedAt}
        conflict={sync.conflict}
        onUseServer={(snapshot) => {
          setContent(snapshot.content);
          setRestoreInto(snapshot.content);
          sync.acceptServer(snapshot);
        }}
        onKeepMine={sync.keepMine}
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
