"use client";

import { Check, Plus, X } from "lucide-react";
import { useRef, useState, useTransition } from "react";

import { updateMySkills } from "@/lib/members/actions";
import { MAX_TAGS_PER_USER, MAX_TAG_LENGTH, parseTags, type TagIssue } from "@/lib/members/tags";

/**
 * 技能标签编辑。
 *
 * 交互上的三个决定：
 *
 * **① 回车 / 逗号 / 顿号都能提交一个标签。**
 * 让人猜「该用哪个分隔符」是没必要的门槛 ——
 * 猜错的人得到一个叫「大模型, RAG」的标签，然后放弃。
 *
 * **② 归一化之后重复的会当场提示，而不是保存后悄悄少一个。**
 * 已经填了「RAG」再填「rag」，界面立刻说「和前面的重复了」。
 *
 * **③ 空状态给具体的例子，不是「添加标签」四个字。**
 * 一个空输入框问「你会什么」，多数人的答案是关掉页面。
 * 给几个真的会被用来找人的例子，门槛就低得多。
 */

const EXAMPLES = ["RAG", "Agent 编排", "微调", "Prompt 工程", "多模态", "推理优化", "评测"];

export function SkillEditor({ initial }: { initial: { slug: string; label: string }[] }) {
  const [tags, setTags] = useState(initial);
  const [draft, setDraft] = useState("");
  const [issues, setIssues] = useState<TagIssue[]>([]);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  const full = tags.length >= MAX_TAGS_PER_USER;

  function commit(next: { slug: string; label: string }[], localIssues: TagIssue[] = []) {
    setTags(next);
    setIssues(localIssues);
    setSaved(null);
    startTransition(async () => {
      const result = await updateMySkills(next.map((t) => t.label));
      if (result.ok) {
        setTags(result.tags ?? next);
        setIssues([...localIssues, ...(result.issues ?? [])]);
        setSaved(result.note ?? "已保存");
      } else {
        setTags(tags); // 失败拨回去，不停在用户以为生效了的位置
        setIssues([{ input: "", reason: result.error ?? "保存失败" }]);
      }
    });
  }

  function add(raw: string) {
    const parsed = parseTags(raw);
    if (parsed.tags.length === 0) {
      setIssues(parsed.issues);
      setDraft("");
      return;
    }

    const existing = new Set(tags.map((t) => t.slug));
    const fresh = parsed.tags.filter((t) => !existing.has(t.slug));
    const dupes: TagIssue[] = parsed.tags
      .filter((t) => existing.has(t.slug))
      .map((t) => ({ input: t.label, reason: "和已有的重复了" }));

    const room = MAX_TAGS_PER_USER - tags.length;
    const overflow: TagIssue[] = fresh
      .slice(room)
      .map((t) => ({ input: t.label, reason: `最多 ${MAX_TAGS_PER_USER} 个` }));

    setDraft("");
    commit([...tags, ...fresh.slice(0, room)], [...parsed.issues, ...dupes, ...overflow]);
  }

  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {tags.map((tag) => (
          <span
            key={tag.slug}
            className="t-footnote inline-flex items-center gap-1 rounded-full bg-[var(--accent-soft)] py-1 pl-2.5 pr-1 text-[var(--accent)]"
          >
            {tag.label}
            <button
              type="button"
              aria-label={`删除 ${tag.label}`}
              disabled={pending}
              onClick={() => commit(tags.filter((t) => t.slug !== tag.slug))}
              className="tap-target rounded-full p-0.5 transition active:opacity-50"
            >
              <X className="h-3 w-3" strokeWidth={2.6} aria-hidden />
            </button>
          </span>
        ))}

        {tags.length === 0 && (
          <span className="t-footnote text-[var(--ink-quaternary)]">还没有标签</span>
        )}
      </div>

      <div className="mt-2.5 flex gap-2">
        <input
          ref={inputRef}
          value={draft}
          disabled={full || pending}
          maxLength={MAX_TAG_LENGTH * 3}
          placeholder={full ? `已经 ${MAX_TAGS_PER_USER} 个了` : "你擅长什么？回车添加"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // 逗号顿号也当提交 —— 别让人猜该用哪个分隔符
            if (e.key === "Enter" || e.key === "," || e.key === "，" || e.key === "、") {
              e.preventDefault();
              add(draft);
            } else if (e.key === "Backspace" && draft === "" && tags.length > 0) {
              commit(tags.slice(0, -1));
            }
          }}
          onBlur={() => draft.trim() && add(draft)}
          className="t-body min-w-0 flex-1 rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 outline-none transition focus:ring-2 focus:ring-[var(--accent)] disabled:opacity-45"
        />
        <button
          type="button"
          disabled={!draft.trim() || full || pending}
          onClick={() => add(draft)}
          className="t-subhead shrink-0 rounded-[var(--radius-control)] bg-[var(--fill)] px-3 font-medium transition active:opacity-60 disabled:opacity-35"
        >
          添加
        </button>
      </div>

      {/* 空状态给具体例子 —— 一个空输入框问「你会什么」，多数人会关掉页面 */}
      {tags.length === 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              disabled={pending}
              onClick={() => add(example)}
              className="t-caption inline-flex items-center gap-0.5 rounded-full bg-[var(--fill)] py-1 pl-2 pr-2.5 text-[var(--ink-secondary)] transition active:opacity-60"
            >
              <Plus className="h-3 w-3" strokeWidth={2.4} aria-hidden />
              {example}
            </button>
          ))}
        </div>
      )}

      <div className="mt-2 space-y-0.5">
        {issues.map((issue, i) => (
          <p key={`${issue.input}-${i}`} className="t-caption" style={{ color: "var(--warning)" }}>
            {issue.input ? `「${issue.input}」${issue.reason}` : issue.reason}
          </p>
        ))}
        {issues.length === 0 && saved && (
          <p className="t-caption flex items-center gap-1 text-[var(--ink-tertiary)]">
            <Check className="h-3.5 w-3.5" strokeWidth={2.4} aria-hidden />
            {saved}
          </p>
        )}
        {issues.length === 0 && !saved && (
          <p className="t-caption text-[var(--ink-quaternary)]">
            最多 {MAX_TAGS_PER_USER} 个，改动立即保存
          </p>
        )}
      </div>
    </div>
  );
}
