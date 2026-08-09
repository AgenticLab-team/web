"use client";

import { GripVertical, Plus, X } from "lucide-react";
import { useState } from "react";

import { DEFAULT_OPTION_SLOTS, MAX_OPTIONS, MAX_OPTION_CHARS } from "@/lib/forum/poll-rules";

/**
 * 发帖时顺带建一个投票。
 *
 * ─────────────────────────────────────────
 * 这个组件补的是一个真实的缺口
 * ─────────────────────────────────────────
 *
 * 站长说「投票只能看不能发」—— 字面意思：`castVote` 接好了、
 * `PollWidget` 渲染得好好的，而 `createPoll` **全站一个调用点都没有**。
 * 能看能投，就是建不出来。
 *
 * ─────────────────────────────────────────
 * 空行不算数，所以不用「删除」也能减选项
 * ─────────────────────────────────────────
 *
 * 校验时空白项直接跳过。所以人清空一行就等于删掉它 ——
 * 删除按钮只是让这件事更明显，不是唯一的路。
 * 这样即使在某个浏览器上按钮点不动，功能也不会卡死。
 */

export interface PollDraft {
  question: string;
  options: string[];
  multi: boolean;
  hideUntilVoted: boolean;
  closesAt: string;
}

export const EMPTY_POLL: PollDraft = {
  question: "",
  options: Array.from({ length: DEFAULT_OPTION_SLOTS }, () => ""),
  multi: false,
  hideUntilVoted: false,
  closesAt: "",
};

export function PollComposer({
  value,
  onChange,
}: {
  value: PollDraft;
  onChange: (next: PollDraft) => void;
}) {
  const [focused, setFocused] = useState<number | null>(null);

  const setOption = (i: number, text: string) => {
    const options = [...value.options];
    options[i] = text;
    onChange({ ...value, options });
  };

  const addOption = () => {
    if (value.options.length >= MAX_OPTIONS) return;
    onChange({ ...value, options: [...value.options, ""] });
  };

  const removeOption = (i: number) => {
    // 少于两个就不给删了 —— 一个选项的投票问不出任何东西
    if (value.options.length <= 2) {
      setOption(i, "");
      return;
    }
    onChange({ ...value, options: value.options.filter((_, k) => k !== i) });
  };

  const filled = value.options.filter((o) => o.trim()).length;

  return (
    <div className="rounded-[var(--radius-card)] bg-[var(--fill)] p-3">
      <label className="t-caption block text-[var(--ink-tertiary)]">
        投票问题（可选，不填就用帖子标题）
        <input
          value={value.question}
          onChange={(e) => onChange({ ...value, question: e.target.value })}
          placeholder="想问大家什么"
          className="t-body mt-1 w-full rounded-[var(--radius-control)] bg-[var(--surface)] px-3 py-2 outline-none placeholder:text-[var(--ink-quaternary)]"
        />
      </label>

      <div className="mt-3 space-y-1.5">
        {value.options.map((option, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <GripVertical
              className="h-3.5 w-3.5 shrink-0 text-[var(--ink-quaternary)]"
              strokeWidth={2}
              aria-hidden
            />
            <input
              value={option}
              maxLength={MAX_OPTION_CHARS}
              onChange={(e) => setOption(i, e.target.value)}
              onFocus={() => setFocused(i)}
              onBlur={() => setFocused(null)}
              aria-label={`选项 ${i + 1}`}
              placeholder={`选项 ${i + 1}`}
              className="t-body min-w-0 flex-1 rounded-[var(--radius-control)] bg-[var(--surface)] px-3 py-2 outline-none placeholder:text-[var(--ink-quaternary)]"
            />
            <button
              type="button"
              onClick={() => removeOption(i)}
              aria-label={`删除选项 ${i + 1}`}
              className="tap-target shrink-0 rounded-full p-1.5 text-[var(--ink-quaternary)] transition active:opacity-50"
            >
              <X className="h-3.5 w-3.5" strokeWidth={2.2} aria-hidden />
            </button>
          </div>
        ))}
      </div>

      {value.options.length < MAX_OPTIONS && (
        <button
          type="button"
          onClick={addOption}
          className="t-caption mt-2 flex items-center gap-1 rounded-[var(--radius-control)] px-2 py-1.5 text-[var(--accent)] transition active:opacity-60"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2.4} aria-hidden />
          加一个选项
        </button>
      )}

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
        <label className="t-caption flex items-center gap-1.5 text-[var(--ink-secondary)]">
          <input
            type="checkbox"
            checked={value.multi}
            onChange={(e) => onChange({ ...value, multi: e.target.checked })}
          />
          可以多选
        </label>
        <label className="t-caption flex items-center gap-1.5 text-[var(--ink-secondary)]">
          <input
            type="checkbox"
            checked={value.hideUntilVoted}
            onChange={(e) => onChange({ ...value, hideUntilVoted: e.target.checked })}
          />
          投票前不显示结果
        </label>
      </div>

      <label className="t-caption mt-3 block text-[var(--ink-tertiary)]">
        截止时间（可选，不填就一直开着）
        <input
          type="datetime-local"
          value={value.closesAt}
          onChange={(e) => onChange({ ...value, closesAt: e.target.value })}
          className="t-body mt-1 w-full rounded-[var(--radius-control)] bg-[var(--surface)] px-3 py-2 outline-none"
        />
      </label>

      {/*
        * 把「现在够不够」直接说出来。
        *
        * 不说的话人填完点发布，才被告诉「至少要两个选项」——
        * 而那时候错误提示出现在页面顶部，他正看着底部的按钮。
        */}
      <p
        className={`t-caption2 mt-2 ${
          filled >= 2 ? "text-[var(--ink-quaternary)]" : "text-[var(--warning)]"
        }`}
      >
        {filled >= 2
          ? `${filled} 个选项 · 空着的行不会算进去`
          : `还差 ${2 - filled} 个选项才能发 —— 只有一个选项的投票问不出任何东西`}
      </p>
      {focused !== null && value.options[focused]?.length >= MAX_OPTION_CHARS && (
        <p className="t-caption2 mt-1 text-[var(--warning)]">
          单个选项最多 {MAX_OPTION_CHARS} 个字
        </p>
      )}
    </div>
  );
}
