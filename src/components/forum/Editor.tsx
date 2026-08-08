"use client";

import { Bold, Code, Eye, Italic, Link2, List, Pencil, Quote } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { previewMarkdown } from "@/lib/forum/preview";

/**
 * Markdown 编辑器。
 *
 * 三件事决定用户敢不敢在这里写长文：
 *   1. 草稿不丢 —— 每 3 秒存本地，离开有拦截，提交失败保留全文
 *   2. 预览与最终结果一致 —— 所以预览走服务端，不在客户端再实现一份
 *   3. 快捷键跟系统一致 —— ⌘B/⌘I/⌘K/⌘Enter
 */

interface EditorProps {
  name: string;
  defaultValue?: string;
  placeholder?: string;
  minHeight?: number;
  draftKey?: string;
  onSubmit?: () => void;
  /** 内容变化回调。表单需要拿到值时用这个，别去监听 DOM 事件冒泡 */
  onValueChange?: (value: string) => void;
}

export function Editor({
  name,
  defaultValue = "",
  placeholder = "写点什么…支持 Markdown",
  minHeight = 220,
  draftKey,
  onSubmit,
  onValueChange,
}: EditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValueRaw] = useState(defaultValue);

  const setValue = useCallback(
    (next: string) => {
      setValueRaw(next);
      onValueChange?.(next);
    },
    [onValueChange],
  );
  const [mode, setMode] = useState<"write" | "preview">("write");
  const [preview, setPreview] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [restored, setRestored] = useState(false);
  const dirty = useRef(false);

  // 恢复草稿
  useEffect(() => {
    if (!draftKey || defaultValue) return;
    const saved = localStorage.getItem(`draft:${draftKey}`);
    if (saved && saved.trim()) {
      setValue(saved);
      setRestored(true);
      setTimeout(() => setRestored(false), 4000);
    }
  }, [draftKey, defaultValue]);

  // 每 3 秒存一次草稿
  useEffect(() => {
    if (!draftKey) return;
    const id = setInterval(() => {
      if (!dirty.current) return;
      localStorage.setItem(`draft:${draftKey}`, value);
      dirty.current = false;
    }, 3000);
    return () => clearInterval(id);
  }, [draftKey, value]);

  // 有未保存内容时拦截离开
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (value.trim() && value !== defaultValue) e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [value, defaultValue]);

  const runPreview = useCallback(async (source: string) => {
    setPreviewing(true);
    try {
      const { html } = await previewMarkdown(source);
      setPreview(html);
    } finally {
      setPreviewing(false);
    }
  }, []);

  useEffect(() => {
    if (mode !== "preview") return;
    const id = setTimeout(() => void runPreview(value), 300);
    return () => clearTimeout(id);
  }, [mode, value, runPreview]);

  /** 在选区两侧插入标记，没选中就插入占位并把光标放中间 */
  const wrap = (before: string, after = before, placeholderText = "文字") => {
    const el = ref.current;
    if (!el) return;
    const { selectionStart: start, selectionEnd: end } = el;
    const selected = value.slice(start, end) || placeholderText;
    const next = value.slice(0, start) + before + selected + after + value.slice(end);
    setValue(next);
    dirty.current = true;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + before.length, start + before.length + selected.length);
    });
  };

  const prefixLines = (prefix: string) => {
    const el = ref.current;
    if (!el) return;
    const { selectionStart: start, selectionEnd: end } = el;
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    const block = value.slice(lineStart, end);
    const next =
      value.slice(0, lineStart) +
      block.split("\n").map((line) => (line.startsWith(prefix) ? line : prefix + line)).join("\n") +
      value.slice(end);
    setValue(next);
    dirty.current = true;
    requestAnimationFrame(() => el.focus());
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    if (e.key === "b") { e.preventDefault(); wrap("**"); }
    else if (e.key === "i") { e.preventDefault(); wrap("*"); }
    else if (e.key === "k") { e.preventDefault(); wrap("[", "](https://)", "链接文字"); }
    else if (e.key === "Enter") { e.preventDefault(); onSubmit?.(); }
  };

  const tools = [
    { icon: Bold, label: "粗体 ⌘B", run: () => wrap("**") },
    { icon: Italic, label: "斜体 ⌘I", run: () => wrap("*") },
    { icon: Link2, label: "链接 ⌘K", run: () => wrap("[", "](https://)", "链接文字") },
    { icon: Code, label: "代码块", run: () => wrap("\n```\n", "\n```\n", "code") },
    { icon: Quote, label: "引用", run: () => prefixLines("> ") },
    { icon: List, label: "列表", run: () => prefixLines("- ") },
  ];

  return (
    <div className="overflow-hidden rounded-[var(--radius-card)] bg-[var(--surface)] hairline">
      <div className="flex items-center gap-0.5 border-b border-[var(--separator)] px-2 py-1.5">
        {tools.map((tool) => (
          <button
            key={tool.label}
            type="button"
            title={tool.label}
            aria-label={tool.label}
            onClick={tool.run}
            className="rounded-[0.375rem] p-1.5 text-[var(--ink-tertiary)] transition-colors hover:bg-[var(--fill)] hover:text-[var(--ink)]"
          >
            <tool.icon className="h-4 w-4" strokeWidth={1.9} aria-hidden />
          </button>
        ))}
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => setMode(mode === "write" ? "preview" : "write")}
          className="t-caption flex items-center gap-1 rounded-[0.375rem] px-2 py-1.5 font-medium text-[var(--ink-secondary)] transition-colors hover:bg-[var(--fill)]"
        >
          {mode === "write" ? (
            <>
              <Eye className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              预览
            </>
          ) : (
            <>
              <Pencil className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              继续写
            </>
          )}
        </button>
      </div>

      {mode === "write" ? (
        <textarea
          ref={ref}
          name={name}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            dirty.current = true;
          }}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          style={{ minHeight }}
          className="t-body w-full resize-y bg-transparent px-4 py-3 outline-none placeholder:text-[var(--ink-quaternary)]"
        />
      ) : (
        <>
          <input type="hidden" name={name} value={value} />
          <div
            style={{ minHeight }}
            className="prose-forum px-4 py-3"
            dangerouslySetInnerHTML={{
              __html: preview || (previewing ? "" : "<p>还没有内容</p>"),
            }}
          />
        </>
      )}

      <div className="t-caption flex items-center justify-between border-t border-[var(--separator)] px-4 py-2 text-[var(--ink-tertiary)]">
        <span>
          {restored ? (
            <span className="text-[var(--success)]">已恢复上次的草稿</span>
          ) : (
            "支持 Markdown · ⌘↵ 发布"
          )}
        </span>
        <span className="tabular">{value.length}</span>
      </div>
    </div>
  );
}
