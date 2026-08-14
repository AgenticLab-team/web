"use client";

import { X } from "lucide-react";
import { useState } from "react";

import { MAX_TAGS_PER_POST, MAX_TAG_LENGTH, slugify } from "@/lib/forum/tag-rules";

/**
 * 发帖时选标签。
 *
 * ─────────────────────────────────────────
 * 已有的标签要摆出来，不能只让人凭空敲
 * ─────────────────────────────────────────
 *
 * 自由输入而没有建议列表，是标签系统烂掉最快的方式：
 * 三个人分别敲出「大模型」「LLM」「大语言模型」，
 * 一年后标签墙上全是同义词，而筛选功能因此等于废了。
 *
 * 归一化（`slugify`）解决的是大小写和空格，解决不了同义词 ——
 * 那只能靠**让人先看见别人用过什么**。所以常用标签直接摆在下面，
 * 点一下就加上。
 */
export function TagInput({
  suggestions,
  required,
  onChange,
}: {
  /** 站里已有的标签，按用得多的排在前面 */
  suggestions: { slug: string; name: string; postCount: number }[];
  /** 这个版块要求至少一个 */
  required?: boolean;
  onChange: (tags: string[]) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [draft, setDraft] = useState("");

  const set = (next: string[]) => {
    setPicked(next);
    onChange(next);
  };

  const add = (raw: string) => {
    const name = raw.trim().slice(0, MAX_TAG_LENGTH);
    if (!name) return;
    // 用**和服务端同一个** slugify 去重 —— 自己写一份「转小写比一比」的话，
    // 「Rag 检索」和「rag-检索」在这里是两个、存进去是一个
    if (picked.some((t) => slugify(t) === slugify(name))) return;
    if (picked.length >= MAX_TAGS_PER_POST) return;
    set([...picked, name]);
    setDraft("");
  };

  const full = picked.length >= MAX_TAGS_PER_POST;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {/*
          * **整个芯片就是删除按钮**，× 只是个提示。
          *
          * 芯片里再套一个小 × 按钮的话，那个按钮只有十几像素 ——
          * 手指点不准，而点歪了落在芯片上什么都不会发生，
          * 于是人会以为删不掉。做成一个大目标反而更简单。
          */}
        {picked.map((tag) => (
          <button
            key={tag}
            type="button"
            onClick={() => set(picked.filter((t) => t !== tag))}
            aria-label={`去掉标签 ${tag}`}
            className="t-caption tap-target inline-flex items-center gap-1 rounded-[var(--radius-pill)] bg-[var(--accent)] px-2.5 py-1.5 font-medium text-[var(--accent-ink)] transition active:scale-95"
          >
            {tag}
            <X className="h-3 w-3 opacity-70" strokeWidth={2.5} aria-hidden />
          </button>
        ))}

        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            /*
             * 回车和逗号都当成「这个标签打完了」。
             *
             * 回车在表单里默认是提交 —— 不拦的话，敲完第一个标签
             * 按回车就把帖子发出去了。
             */
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add(draft);
            } else if (e.key === "Backspace" && draft === "" && picked.length > 0) {
              // 空输入框上退格删掉最后一个 —— 和所有人习惯的标签框一致
              set(picked.slice(0, -1));
            }
          }}
          onBlur={() => add(draft)}
          disabled={full}
          maxLength={MAX_TAG_LENGTH}
          placeholder={
            full ? `最多 ${MAX_TAGS_PER_POST} 个` : picked.length === 0 ? "加个标签，回车确认" : "还可以加"
          }
          className="t-caption min-h-11 min-w-32 flex-1 bg-transparent py-1 outline-none placeholder:text-[var(--ink-quaternary)]"
        />
      </div>

      {suggestions.length > 0 && !full && (
        <div className="flex flex-wrap gap-1.5">
          {suggestions
            .filter((s) => !picked.some((t) => slugify(t) === s.slug))
            .slice(0, 8)
            .map((s) => (
              <button
                key={s.slug}
                type="button"
                onClick={() => add(s.name)}
                className="t-caption2 inline-flex items-center gap-1 rounded-[var(--radius-pill)] bg-[var(--fill)] px-2 py-0.5 text-[var(--ink-secondary)] transition-colors hover:bg-[var(--fill-strong)]"
              >
                {s.name}
                <span className="tabular text-[var(--ink-quaternary)]">{s.postCount}</span>
              </button>
            ))}
        </div>
      )}

      <p className="t-caption2 text-[var(--ink-quaternary)]">
        {required
          ? "这个版块要求至少一个标签 —— 别人靠它找到你这篇"
          : "标签让这篇以后还找得到。最多 " + MAX_TAGS_PER_POST + " 个"}
      </p>
    </div>
  );
}
