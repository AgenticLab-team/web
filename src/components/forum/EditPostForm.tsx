"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Editor } from "@/components/forum/Editor";
import { editPost } from "@/lib/forum/actions";

/**
 * 编辑帖子。
 *
 * changeNote 单独要一栏：编辑历史公开可查是论坛信任的底线，
 * 一句「改了什么」比让读者自己 diff 两个版本友好得多。
 */
export function EditPostForm({
  postId,
  initialTitle,
  initialContent,
}: {
  postId: string;
  initialTitle: string;
  initialContent: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState(initialTitle);
  const [content, setContent] = useState(initialContent);
  const [changeNote, setChangeNote] = useState("");

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const result = await editPost({ postId, title, content, changeNote: changeNote || undefined });
      if (!result.ok) {
        // 失败时绝不清空内容 —— 改了半小时的长文被清掉，人就再也不回来了
        setError(result.error ?? "保存失败");
        return;
      }
      router.push(`/forum/p/${postId}`);
      router.refresh();
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
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        aria-label="标题"
        placeholder="标题"
        maxLength={120}
        className="t-title3 w-full rounded-[var(--radius-card)] bg-[var(--surface)] px-4 py-3.5 outline-none hairline placeholder:text-[var(--ink-quaternary)]"
      />

      <Editor
        name="content"
        defaultValue={initialContent}
        minHeight={280}
        placeholder="正文…支持 Markdown、代码块、@提及"
        onValueChange={setContent}
        onSubmit={submit}
      />

      <input
        value={changeNote}
        onChange={(e) => setChangeNote(e.target.value)}
        maxLength={120}
        aria-label="修改说明"
        placeholder="改了什么？（可选，会显示在编辑历史里）"
        className="t-footnote w-full rounded-[var(--radius-control)] bg-[var(--surface)] px-4 py-3 outline-none hairline placeholder:text-[var(--ink-quaternary)]"
      />

      {error && (
        <p
          className="t-footnote rounded-[var(--radius-control)] bg-[var(--danger)]/10 px-3 py-2.5 text-[var(--danger)]"
          role="alert"
        >
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending || !title.trim() || !content.trim()}
          className="t-body flex-1 rounded-[var(--radius-control)] bg-[var(--accent)] px-6 py-3 font-medium text-[var(--accent-ink)] transition active:scale-[0.98] disabled:opacity-40"
        >
          {pending ? "保存中…" : "保存修改"}
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
