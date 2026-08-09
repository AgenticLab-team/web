"use client";

import { Check } from "lucide-react";
import { useState, useTransition } from "react";

import { updateMyBio } from "@/lib/members/actions";

const MAX = 140;

/**
 * 一句话简介。
 *
 * 失焦即保存 —— 这一页上唯一的产出是「别人看到什么」，
 * 而一个需要另外按保存的输入框，最常见的结局是内容留在框里没进库。
 */
export function BioEditor({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [committed, setCommitted] = useState(initial);

  function save() {
    if (value === committed) return;
    startTransition(async () => {
      const result = await updateMyBio(value);
      if (result.ok) {
        setCommitted(value);
        setSaved(result.note ?? "已保存");
      } else {
        setValue(committed);
        setSaved(result.error ?? "保存失败");
      }
    });
  }

  const left = MAX - value.length;

  return (
    <div>
      <textarea
        value={value}
        maxLength={MAX}
        rows={2}
        disabled={pending}
        placeholder="在做什么、想找什么样的人聊 —— 一两句就够"
        onChange={(e) => {
          setValue(e.target.value);
          setSaved(null);
        }}
        onBlur={save}
        className="t-body w-full resize-none rounded-[var(--radius-card)] bg-[var(--fill)] px-3.5 py-2.5 leading-relaxed outline-none transition focus:ring-2 focus:ring-[var(--accent)] disabled:opacity-45"
      />
      <div className="mt-1 flex items-center justify-between px-1">
        {saved ? (
          <p className="t-caption flex items-center gap-1 text-[var(--ink-tertiary)]">
            <Check className="h-3.5 w-3.5" strokeWidth={2.4} aria-hidden />
            {saved}
          </p>
        ) : (
          <p className="t-caption text-[var(--ink-quaternary)]">离开输入框即保存</p>
        )}
        <span
          className="tabular t-caption"
          style={{ color: left < 20 ? "var(--warning)" : "var(--ink-quaternary)" }}
        >
          {left}
        </span>
      </div>
    </div>
  );
}
