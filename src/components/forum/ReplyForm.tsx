"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Editor } from "@/components/forum/Editor";
import { createReply } from "@/lib/forum/actions";

export function ReplyForm({ postId, locked }: { postId: string; locked: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [key, setKey] = useState(0);

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
      const result = await createReply({ postId, content });
      if (!result.ok) {
        setError(result.error ?? "回复失败");
        return;
      }
      localStorage.removeItem(`draft:reply:${postId}`);
      setContent("");
      // 换掉 key 让编辑器重建，清空内容且不残留草稿
      setKey((k) => k + 1);
      router.refresh();
    });
  };

  return (
    <div className="space-y-3">
      <Editor
        key={key}
        name="reply"
        draftKey={`reply:${postId}`}
        minHeight={110}
        placeholder="写下你的回复…"
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
        {pending ? "发送中…" : "回复"}
      </button>
    </div>
  );
}
