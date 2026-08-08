"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { useToast } from "@/components/ui/Toast";
import { addWord, removeWord, updateWord } from "@/lib/admin/word-actions";
import { KIND_HINTS, KIND_LABELS, type WordKind } from "@/lib/moderation/words";

export interface WordItem {
  id: string;
  word: string;
  kind: WordKind;
  replacement: string | null;
  enabled: boolean;
  hitCount: number;
}

/**
 * 词库列表与新增。
 *
 * 档位选择器把**每一档的代价**直接写出来，而不是三个干巴巴的名字。
 * 「拦截」听起来最有力，实际上代价最大：误伤时对方内容直接没了，
 * 而他往往不知道为什么。默认选中送审。
 *
 * 命中次数排在最前列：命中特别多的规则**大概率是误伤**，
 * 而不是「这条规则很有用」。
 */
export function WordList({ words }: { words: WordItem[] }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  const [word, setWord] = useState("");
  const [kind, setKind] = useState<WordKind>("review");
  const [replacement, setReplacement] = useState("");
  const [reason, setReason] = useState("");

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, success: string) => {
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        toast.show({ message: result.error ?? "操作失败", kind: "error" });
        return;
      }
      toast.show({ message: success, kind: "success" });
      setWord("");
      setReplacement("");
      setReason("");
      router.refresh();
    });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2.5 rounded-[var(--radius-card)] bg-[var(--surface)] p-4 hairline">
        <p className="t-caption2 font-medium uppercase tracking-[0.06em] text-[var(--ink-quaternary)]">
          新增词条
        </p>

        <input
          value={word}
          onChange={(e) => setWord(e.target.value)}
          placeholder="词条（至少两个字，空格和标点会被忽略）"
          className={inputClass}
        />

        <div className="space-y-1.5">
          {(Object.keys(KIND_LABELS) as WordKind[]).map((k) => (
            <label
              key={k}
              className={`flex cursor-pointer items-start gap-2.5 rounded-[var(--radius-control)] px-3 py-2 transition-colors ${
                kind === k ? "bg-[var(--fill)]" : ""
              }`}
            >
              <input
                type="radio"
                name="kind"
                checked={kind === k}
                onChange={() => setKind(k)}
                className="mt-1 h-3.5 w-3.5"
              />
              <span className="min-w-0">
                <span className="t-subhead block">{KIND_LABELS[k]}</span>
                {/* 把代价写出来，而不是三个干巴巴的名字 */}
                <span className="t-caption block text-[var(--ink-tertiary)]">{KIND_HINTS[k]}</span>
              </span>
            </label>
          ))}
        </div>

        {kind === "replace" && (
          <input
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            placeholder="替换成什么"
            className={inputClass}
          />
        )}

        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="理由（必填，会记入审计日志）"
          className={inputClass}
        />

        <button
          type="button"
          disabled={pending || !word.trim() || !reason.trim()}
          onClick={() => run(() => addWord({ word, kind, replacement, reason }), "已加入词库")}
          className="t-subhead w-full rounded-[var(--radius-control)] bg-[var(--accent)] px-4 py-2 font-medium text-[var(--accent-ink)] disabled:opacity-40"
        >
          加入词库
        </button>
      </div>

      {words.length === 0 ? (
        <p className="t-caption px-1 leading-relaxed text-[var(--ink-tertiary)]">
          词库是空的。这不一定是坏事 —— 子串匹配必然误伤，
          在真的出现问题之前，空词库比一份抄来的词库安全得多。
        </p>
      ) : (
        <div className="inset-group">
          {words.map((item) => (
            <div key={item.id} className="inset-row flex items-center gap-2 px-4 py-2.5">
              <span className={`t-body min-w-0 flex-1 truncate ${item.enabled ? "" : "opacity-45"}`}>
                {item.word}
                {item.replacement && (
                  <span className="t-caption2 ml-1.5 text-[var(--ink-quaternary)]">
                    → {item.replacement}
                  </span>
                )}
              </span>

              <select
                value={item.kind}
                onChange={(e) =>
                  run(
                    () =>
                      updateWord({
                        id: item.id,
                        kind: e.target.value as WordKind,
                        replacement: item.replacement ?? undefined,
                        enabled: item.enabled,
                      }),
                    "已修改",
                  )
                }
                className="t-caption shrink-0 rounded-[var(--radius-control)] bg-[var(--fill)] px-2 py-1 outline-none"
              >
                {(Object.keys(KIND_LABELS) as WordKind[]).map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABELS[k]}
                  </option>
                ))}
              </select>

              <span
                className="tabular t-caption shrink-0 text-[var(--ink-tertiary)]"
                title={
                  item.hitCount > 50
                    ? "命中特别多 —— 大概率是误伤，不是这条规则很有用"
                    : "累计命中次数"
                }
                style={item.hitCount > 50 ? { color: "var(--warning)" } : undefined}
              >
                {item.hitCount}
              </span>

              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  run(
                    () =>
                      updateWord({
                        id: item.id,
                        kind: item.kind,
                        replacement: item.replacement ?? undefined,
                        enabled: !item.enabled,
                      }),
                    item.enabled ? "已停用" : "已启用",
                  )
                }
                className="t-caption shrink-0 rounded-[var(--radius-pill)] bg-[var(--fill)] px-2.5 py-1 text-[var(--ink-secondary)]"
              >
                {item.enabled ? "停用" : "启用"}
              </button>

              <button
                type="button"
                disabled={pending || !reason.trim()}
                title={reason.trim() ? "删除" : "先在上面填个理由"}
                onClick={() => run(() => removeWord({ id: item.id, reason }), "已删除")}
                className="t-caption shrink-0 rounded-[var(--radius-pill)] px-2.5 py-1 disabled:opacity-30"
                style={{ color: "var(--danger)" }}
              >
                删除
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const inputClass =
  "t-subhead w-full rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 outline-none placeholder:text-[var(--ink-quaternary)]";
