"use client";

import { Bold, Code, Eye, ImagePlus, Italic, Link2, List, Pencil, Quote } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { previewMarkdown } from "@/lib/forum/preview";

import { readLocalDraft, writeLocalDraft } from "./local-draft";
import { filesFromDrop, filesFromPaste, useUpload } from "./use-upload";

/**
 * Markdown 编辑器。
 *
 * 三件事决定用户敢不敢在这里写长文：
 *   1. 草稿不丢 —— 每 3 秒存本地，离开有拦截，提交失败保留全文
 *   2. 预览与最终结果一致 —— 所以预览走服务端，不在客户端再实现一份
 *   3. 快捷键跟系统一致 —— ⌘B/⌘I/⌘K/⌘Enter
 */

/**
 * 工具栏按钮定义成**纯数据**，放在组件外面。
 *
 * 原先每次渲染都现场造一个带闭包的数组，闭包里读 ref ——
 * React 的规则不允许在渲染期间访问 ref（并发渲染下渲染可能被丢弃重来，
 * 那时读到的 ref 是上一次的）。改成数据 + 一个 dispatch 函数之后，
 * 闭包只在事件处理里产生，顺带也不用每次渲染重建六个函数。
 */
type ToolAction =
  | { kind: "wrap"; before: string; after?: string; placeholder?: string }
  | { kind: "prefix"; prefix: string };

const TOOLS: { icon: typeof Bold; label: string; action: ToolAction }[] = [
  { icon: Bold, label: "粗体 ⌘B", action: { kind: "wrap", before: "**" } },
  { icon: Italic, label: "斜体 ⌘I", action: { kind: "wrap", before: "*" } },
  {
    icon: Link2,
    label: "链接 ⌘K",
    action: { kind: "wrap", before: "[", after: "](https://)", placeholder: "链接文字" },
  },
  {
    icon: Code,
    label: "代码块",
    action: { kind: "wrap", before: "\n```\n", after: "\n```\n", placeholder: "code" },
  },
  { icon: Quote, label: "引用", action: { kind: "prefix", prefix: "> " } },
  { icon: List, label: "列表", action: { kind: "prefix", prefix: "- " } },
];

interface EditorProps {
  name: string;
  defaultValue?: string;
  placeholder?: string;
  minHeight?: number;
  draftKey?: string;
  onSubmit?: () => void;
  /** 内容变化回调。表单需要拿到值时用这个，别去监听 DOM 事件冒泡 */
  onValueChange?: (value: string) => void;
  /**
   * 从外面把内容换掉（恢复服务端草稿用）。
   *
   * `defaultValue` 只在挂载时读一次，恢复草稿时改它没有任何效果 ——
   * 所以要这么一个显式通道。传 null 表示「不要动」。
   */
  restoreValue?: string | null;
}

export function Editor({
  name,
  defaultValue = "",
  placeholder = "写点什么…支持 Markdown",
  minHeight = 220,
  draftKey,
  onSubmit,
  onValueChange,
  restoreValue = null,
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
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  /*
   * 全文的镜像。
   *
   * 上传是异步的：几秒后回来要拿**那一刻**的全文去替换占位串，
   * 而闭包里捕获的 `value` 是发起上传那一刻的旧值 ——
   * 用它会把这期间敲的字全部抹掉。
   *
   * 写在渲染期是被 React Compiler 禁止的（渲染可能被丢弃重来），
   * 所以放在 effect 里同步。
   */
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  /*
   * 恢复草稿。
   *
   * 不能在 effect 体里同步 setState（会触发级联渲染），所以推到下一个任务里。
   * 顺带解决了一个更实际的问题：恢复前**再确认一次输入框还是空的** ——
   * 用户如果在这一瞬间已经开始打字了，把草稿盖上去会直接吞掉他刚写的东西，
   * 而那正是这个功能最想避免的事。
   */
  useEffect(() => {
    if (!draftKey || defaultValue) return;

    const saved = readLocalDraft(draftKey)?.content;
    if (!saved || !saved.trim()) return;

    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    const restoreTimer = setTimeout(() => {
      if (ref.current && ref.current.value !== "") return;
      setValue(saved);
      setRestored(true);
      hideTimer = setTimeout(() => setRestored(false), 4000);
    }, 0);

    return () => {
      clearTimeout(restoreTimer);
      if (hideTimer) clearTimeout(hideTimer);
    };
  }, [draftKey, defaultValue, setValue]);

  /*
   * 外面要求换内容（恢复了一份服务端草稿）。
   *
   * 比对一下再写，不然每次父组件重渲染都会把光标打回原处 ——
   * 而人可能正在这段文字里改字。
   */
  useEffect(() => {
    if (restoreValue === null) return;
    if (ref.current?.value === restoreValue) return;
    setValue(restoreValue);
    dirty.current = true;
  }, [restoreValue, setValue]);

  // 每 3 秒存一次草稿
  useEffect(() => {
    if (!draftKey) return;
    const id = setInterval(() => {
      if (!dirty.current) return;
      writeLocalDraft(draftKey, value);
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

  const runTool = (action: ToolAction) => {
    if (action.kind === "wrap") wrap(action.before, action.after, action.placeholder);
    else prefixLines(action.prefix);
  };

  /** 在光标处插一段文本。上传的占位串走这条路 */
  const insertAtCursor = useCallback(
    (text: string) => {
      const el = ref.current;
      const current = valueRef.current;
      const at = el ? el.selectionStart : current.length;
      const next = current.slice(0, at) + text + current.slice(at);
      valueRef.current = next;
      setValue(next);
      dirty.current = true;
      // 光标落在插入的这段之后，人接着写不会覆盖它
      requestAnimationFrame(() => {
        el?.focus();
        el?.setSelectionRange(at + text.length, at + text.length);
      });
    },
    [setValue],
  );

  const uploader = useUpload({
    getValue: () => valueRef.current,
    setValue: (next) => {
      setValue(next);
      dirty.current = true;
    },
    insertAtCursor,
  });

  const pickFile = () => fileInput.current?.click();

  /*
   * 拖拽的三个事件都要接。
   *
   * 只接 onDrop 是不够的：不 preventDefault 掉 dragover 的话，
   * 浏览器的默认行为是**用这个文件替换掉整个页面** ——
   * 人拖一张图进来，整篇没保存的正文就没了。
   */
  const onDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    setDragging(true);
  };
  const onDrop = (e: React.DragEvent) => {
    const files = filesFromDrop(e);
    if (files.length === 0) return;
    e.preventDefault();
    setDragging(false);
    void uploader.upload(files);
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = filesFromPaste(e);
    // 剪贴板里没有文件时**什么都不做** —— 拦下来的话粘贴文字会失效
    if (files.length === 0) return;
    e.preventDefault();
    void uploader.upload(files);
  };

  return (
    <div className="overflow-hidden rounded-[var(--radius-card)] bg-[var(--surface)] hairline">
      <div className="flex items-center gap-0.5 border-b border-[var(--separator)] px-2 py-1.5">
        {TOOLS.map((tool) => (
          <button
            key={tool.label}
            type="button"
            title={tool.label}
            aria-label={tool.label}
            onClick={() => runTool(tool.action)}
            className="tap-target rounded-[var(--radius-chip)] p-1.5 text-[var(--ink-tertiary)] transition-colors hover:bg-[var(--fill)] hover:text-[var(--ink)]"
          >
            <tool.icon className="h-4 w-4" strokeWidth={1.9} aria-hidden />
          </button>
        ))}
        {/*
          * 插图放在工具栏最后一个，和别的格式按钮分开一点 ——
          * 它是唯一一个会产生网络请求、会失败、会花几秒的按钮，
          * 混在「加粗」旁边会让人以为它一样是瞬时的。
          */}
        <button
          type="button"
          title="插入图片或视频"
          aria-label="插入图片或视频"
          disabled={uploader.busy}
          onClick={pickFile}
          className="tap-target rounded-[var(--radius-chip)] p-1.5 text-[var(--ink-tertiary)] transition-colors hover:bg-[var(--fill)] hover:text-[var(--ink)] disabled:opacity-40"
        >
          <ImagePlus className="h-4 w-4" strokeWidth={1.9} aria-hidden />
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/*,video/*"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) void uploader.upload(e.target.files);
            // 清空，否则连续选同一个文件不会再触发 change
            e.target.value = "";
          }}
        />

        <span className="flex-1" />
        <button
          type="button"
          onClick={() => setMode(mode === "write" ? "preview" : "write")}
          className="t-caption flex items-center gap-1 rounded-[var(--radius-chip)] px-2 py-1.5 font-medium text-[var(--ink-secondary)] transition-colors hover:bg-[var(--fill)]"
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
        <div
          className="relative"
          onDragOver={onDragOver}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <textarea
            ref={ref}
            name={name}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              dirty.current = true;
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder={placeholder}
            style={{ minHeight }}
            className="t-body w-full resize-y bg-transparent px-4 py-3 outline-none placeholder:text-[var(--ink-quaternary)]"
          />

          {/*
            * 拖进来时盖一层。`pointer-events-none` 是必需的 ——
            * 不加的话这一层会把 drop 事件自己接走，
            * 于是拖拽在**看起来最像能放开的那一刻**失效。
            */}
          {dragging && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-[var(--radius-card)] border-2 border-dashed border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]">
              <p className="t-subhead font-medium text-[var(--accent)]">松手就传上去</p>
            </div>
          )}
        </div>
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

      {/*
        * 上传出错单独一行，而且**不自动消失**。
        *
        * 混进下面那条状态栏里的话，「传不上去」和「支持 Markdown」
        * 会在同一个位置来回换，人根本注意不到出过错 ——
        * 而他正等着那张图出现。
        */}
      {uploader.error && (
        <div className="flex items-start gap-2 border-t border-[var(--separator)] px-4 py-2">
          <p className="t-caption flex-1 text-[var(--danger)]" role="alert">
            {uploader.error}
          </p>
          <button
            type="button"
            onClick={uploader.clearError}
            className="t-caption2 shrink-0 text-[var(--ink-tertiary)]"
          >
            知道了
          </button>
        </div>
      )}

      <div className="t-caption flex items-center justify-between border-t border-[var(--separator)] px-4 py-2 text-[var(--ink-tertiary)]">
        <span>
          {uploader.busy ? (
            <span className="text-[var(--accent)]" role="status">
              正在传 {uploader.active[0]}
              {uploader.active.length > 1 ? ` 等 ${uploader.active.length} 个` : ""}…
            </span>
          ) : restored ? (
            <span className="text-[var(--success)]">已恢复上次的草稿</span>
          ) : (
            "支持 Markdown · 可以直接粘贴或拖入图片 · ⌘↵ 发布"
          )}
        </span>
        <span className="tabular">{value.length}</span>
      </div>
    </div>
  );
}
