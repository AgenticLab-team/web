"use client";

import { useState, useTransition } from "react";

import { previewScan } from "@/lib/admin/word-actions";
import { kindLabel, type ScanResult } from "@/lib/moderation/words";

/**
 * 词库预览器。
 *
 * 这是整个敏感词页面上最重要的东西。词库是一堆字符串，
 * 光看列表想象不出它会命中什么 —— 尤其是子串误伤：
 * 某个人的昵称、一个常见技术名词、成语里的两个字。
 * **试一下比想一小时管用。**
 *
 * 命中处直接在原文里高亮，而不是只列出「命中了 X」——
 * 看见它出现在哪一句里，才知道是不是误伤。
 */
export function WordTester() {
  const [text, setText] = useState("");
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const run = () => {
    startTransition(async () => {
      const res = await previewScan(text);
      if (!res.ok) {
        setError(res.error ?? "预览失败");
        setResult(null);
        return;
      }
      setError(null);
      setResult(res.result ?? null);
    });
  };

  return (
    <div className="space-y-2.5 rounded-[var(--radius-card)] bg-[var(--surface)] p-4 hairline">
      <p className="t-caption2 font-medium uppercase tracking-[0.06em] text-[var(--ink-quaternary)]">
        拿真文本试一下
      </p>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        placeholder="粘一段群聊记录或帖子进来，看看词库会命中什么"
        className="t-subhead w-full resize-none rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 outline-none placeholder:text-[var(--ink-quaternary)]"
      />

      <button
        type="button"
        disabled={pending || !text.trim()}
        onClick={run}
        className="t-subhead w-full rounded-[var(--radius-control)] bg-[var(--accent)] px-4 py-2 font-medium text-[var(--accent-ink)] disabled:opacity-40"
      >
        {pending ? "扫描中…" : "扫描"}
      </button>

      {error && <p className="t-caption text-[var(--danger)]">{error}</p>}

      {result && (
        <div className="space-y-2">
          <Verdict result={result} />

          {result.hits.length > 0 && (
            <>
              <p className="t-caption2 text-[var(--ink-quaternary)]">命中位置</p>
              <p className="t-subhead whitespace-pre-wrap break-words rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 leading-relaxed">
                {highlight(text, result)}
              </p>
            </>
          )}

          {result.replaced !== text && (
            <>
              <p className="t-caption2 text-[var(--ink-quaternary)]">替换后</p>
              <p className="t-subhead whitespace-pre-wrap break-words rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 leading-relaxed">
                {result.replaced}
              </p>
            </>
          )}

          <ul className="space-y-0.5">
            {result.hits.map((hit, i) => (
              <li key={i} className="t-caption text-[var(--ink-tertiary)]">
                「{hit.word}」· {kindLabel(hit.kind)} · 第 {hit.start + 1} 字
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="t-caption leading-relaxed text-[var(--ink-tertiary)]">
        预览**不计入命中次数** —— 试几下就把统计打脏的话，
        「命中特别多说明是误伤」这个判断就失真了。
      </p>
    </div>
  );
}

function Verdict({ result }: { result: ScanResult }) {
  const tone =
    result.verdict === "block"
      ? "var(--danger)"
      : result.verdict === "review"
        ? "var(--warning)"
        : "var(--success)";

  const label =
    result.verdict === "block"
      ? "会被拦截，发不出去"
      : result.verdict === "review"
        ? "照常发布，但会进审核队列"
        : result.replaced !== ""
          ? "放行"
          : "放行";

  return (
    <p className="t-subhead font-medium" style={{ color: tone }}>
      {label}
      {result.hits.length > 0 && (
        <span className="t-caption font-normal text-[var(--ink-tertiary)]">
          {" "}
          · 命中 {result.hits.length} 处
        </span>
      )}
    </p>
  );
}

/**
 * 在原文里标出命中处。
 *
 * 命中区间可能重叠（两条规则命中同一段），所以先按起点排序再合并 ——
 * 不合并的话渲染出来的片段会互相覆盖，看到的是一段乱码。
 */
function highlight(text: string, result: ScanResult) {
  const ranges = [...result.hits]
    .map((h) => ({ start: h.start, end: h.end }))
    .sort((a, b) => a.start - b.start);

  const merged: { start: number; end: number }[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }

  const parts: React.ReactNode[] = [];
  let cursor = 0;
  merged.forEach((range, i) => {
    if (range.start > cursor) parts.push(text.slice(cursor, range.start));
    parts.push(
      <mark
        key={i}
        className="rounded-[3px] px-0.5"
        style={{ background: "color-mix(in srgb, var(--warning) 35%, transparent)", color: "inherit" }}
      >
        {text.slice(range.start, range.end)}
      </mark>,
    );
    cursor = range.end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));

  return parts;
}
