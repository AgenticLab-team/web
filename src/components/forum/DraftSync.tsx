"use client";

import { CloudCheck, CloudUpload, TriangleAlert } from "lucide-react";

import type { DraftSnapshot } from "@/lib/forum/draft-rules";

/**
 * 草稿同步的状态条 + 冲突的选择。
 *
 * ─────────────────────────────────────────
 * 不自动合并
 * ─────────────────────────────────────────
 *
 * 两段自由文本没有正确的自动合并方式。机器一合就是把两句话
 * 搅在一起，而那比丢掉一份更糟 —— 丢了还知道自己丢了，
 * 搅在一起的那份看起来是完整的。
 *
 * 所以两份都原样摆出来，让人选。选之前不动任何一边。
 */
export function DraftSync({
  saving,
  savedAt,
  conflict,
  onUseServer,
  onKeepMine,
}: {
  saving: boolean;
  savedAt: number | null;
  conflict: DraftSnapshot | null;
  onUseServer: (snapshot: DraftSnapshot) => void;
  onKeepMine: (serverUpdatedAt: number) => void;
}) {
  if (conflict) {
    return (
      <div className="rounded-[var(--radius-control)] border border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_8%,transparent)] p-3">
        <p className="t-subhead flex items-center gap-1.5 font-medium">
          <TriangleAlert
            className="h-4 w-4 shrink-0 text-[var(--warning)]"
            strokeWidth={2.2}
            aria-hidden
          />
          另一台设备上有更新的草稿
        </p>
        <p className="t-caption mt-1 leading-relaxed text-[var(--ink-secondary)]">
          在你写这一份的时候，别的地方也存过一次。两份都在，选一份 ——
          没选之前谁也不会被覆盖。
        </p>

        {/* 先给人看那一份长什么样，不然「选一个」等于抛硬币 */}
        <pre className="t-caption mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-control)] bg-[var(--fill)] p-2.5 text-[var(--ink-secondary)]">
          {conflict.title ? `${conflict.title}\n\n` : ""}
          {conflict.content.slice(0, 400)}
          {conflict.content.length > 400 ? "…" : ""}
        </pre>

        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onUseServer(conflict)}
            className="t-caption rounded-[var(--radius-control)] bg-[var(--accent)] px-3 py-1.5 font-medium text-[var(--accent-ink)] transition active:scale-95"
          >
            用那一份
          </button>
          <button
            type="button"
            onClick={() => onKeepMine(conflict.updatedAt)}
            className="t-caption rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-1.5 font-medium transition active:scale-95"
          >
            用我现在写的这份
          </button>
        </div>
      </div>
    );
  }

  /*
   * 平时只是一行很轻的字。
   *
   * 「已保存」这类提示做得显眼的话，人会一直盯着它看有没有变 ——
   * 而它的意义只是在人想起来担心的时候能找到一句答复。
   */
  return (
    <p className="t-caption2 flex items-center gap-1 text-[var(--ink-quaternary)]">
      {saving ? (
        <>
          <CloudUpload className="h-3 w-3" strokeWidth={2} aria-hidden />
          正在存到服务器
        </>
      ) : savedAt ? (
        <>
          <CloudCheck className="h-3 w-3" strokeWidth={2} aria-hidden />
          已存到服务器，换设备也能接着写
        </>
      ) : (
        <>
          <CloudUpload className="h-3 w-3" strokeWidth={2} aria-hidden />
          写下的内容会自动存到服务器
        </>
      )}
    </p>
  );
}
