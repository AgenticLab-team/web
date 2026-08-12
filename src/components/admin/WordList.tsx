"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  AdminButton,
  AdminNote,
  AdminPanel,
  AdminPanelLabel,
  AdminRow,
  adminFieldClass,
} from "@/components/admin/ui";
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
      <AdminPanel className="space-y-2.5">
        <AdminPanelLabel>新增词条</AdminPanelLabel>

        <input
          value={word}
          onChange={(e) => setWord(e.target.value)}
          placeholder="词条（至少两个字，空格和标点会被忽略）"
          className={adminFieldClass}
        />

        <div className="space-y-1.5">
          {(Object.keys(KIND_LABELS) as WordKind[]).map((k) => (
            <label
              key={k}
              className={`flex min-h-11 cursor-pointer items-start gap-2.5 rounded-[var(--radius-control)] px-3 py-2 transition-colors ${
                kind === k ? "bg-[var(--fill)]" : "hover:bg-[var(--fill)]"
              }`}
            >
              {/* 单选钮从 14px 提到 18px —— 它是这个表单里唯一要用手指点的圆点 */}
              <input
                type="radio"
                name="kind"
                checked={kind === k}
                onChange={() => setKind(k)}
                className="mt-0.5 h-[18px] w-[18px] shrink-0 accent-[var(--accent)]"
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
            className={adminFieldClass}
          />
        )}

        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="理由（必填，会记入审计日志）"
          className={adminFieldClass}
        />

        <AdminButton
          tone="primary"
          block
          disabled={pending || !word.trim() || !reason.trim()}
          onClick={() => run(() => addWord({ word, kind, replacement, reason }), "已加入词库")}
        >
          加入词库
        </AdminButton>
      </AdminPanel>

      {words.length === 0 ? (
        <AdminNote>
          词库是空的。这不一定是坏事 —— 子串匹配必然误伤，
          在真的出现问题之前，空词库比一份抄来的词库安全得多。
        </AdminNote>
      ) : (
        <div className="inset-group">
          {words.map((item) => (
            /* 手机上换行：一行里塞词条 + 档位下拉 + 命中数 + 两个按钮，
               375px 下词条本身会被压到只剩两个字 */
            <AdminRow key={item.id} className="flex-wrap">
              <span
                className={`t-body min-w-0 flex-1 basis-full truncate sm:basis-auto ${
                  item.enabled ? "" : "opacity-45"
                }`}
              >
                {item.word}
                {item.replacement && (
                  <span className="t-caption2 ml-1.5 text-[var(--ink-quaternary)]">
                    → {item.replacement}
                  </span>
                )}
              </span>

              <select
                value={item.kind}
                aria-label={`「${item.word}」的处置档位`}
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
                className="t-caption min-h-9 shrink-0 rounded-[var(--radius-control)] bg-[var(--fill)] px-2 outline-none"
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

              <AdminButton
                tone="neutral"
                size="sm"
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
              >
                {item.enabled ? "停用" : "启用"}
              </AdminButton>

              {/* 删词是可逆的（再加回来就是了），所以 dangerSoft 而不是实心红。
                  它原来是一个没有底色的裸红字，在一排灰按钮里看起来
                  像是坏掉的文本而不是可点的东西 */}
              <AdminButton
                tone="dangerSoft"
                size="sm"
                disabled={pending || !reason.trim()}
                title={reason.trim() ? "从词库里删掉" : "先在上面填个理由"}
                onClick={() => run(() => removeWord({ id: item.id, reason }), "已删除")}
              >
                删除
              </AdminButton>
            </AdminRow>
          ))}
        </div>
      )}
    </div>
  );
}
