"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { submitAppeal } from "@/lib/forum/appeals";

export function AppealForm({ actionId }: { actionId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="t-caption rounded-[var(--radius-pill)] bg-[var(--fill)] px-2.5 py-1 text-[var(--ink-secondary)] transition hover:bg-[var(--fill-strong)]"
      >
        我要申诉
      </button>
    );
  }

  return (
    <div className="space-y-2">
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="说说你的看法，会由另一位管理员处理"
        rows={3}
        maxLength={1000}
        autoFocus
        className="t-footnote w-full resize-none rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 outline-none placeholder:text-[var(--ink-quaternary)]"
      />
      {error && (
        <p className="t-caption text-[var(--danger)]" role="alert">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={pending || content.trim().length < 5}
          onClick={() =>
            startTransition(async () => {
              const result = await submitAppeal({ actionId, content });
              if (!result.ok) setError(result.error ?? "提交失败");
              else {
                setOpen(false);
                router.refresh();
              }
            })
          }
          className="t-caption rounded-[var(--radius-control)] bg-[var(--accent)] px-3 py-1.5 font-medium text-[var(--accent-ink)] disabled:opacity-40"
        >
          提交申诉
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="t-caption px-3 py-1.5 text-[var(--ink-tertiary)]"
        >
          取消
        </button>
      </div>
    </div>
  );
}
