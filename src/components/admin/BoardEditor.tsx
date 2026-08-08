"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { useToast } from "@/components/ui/Toast";
import { deleteBoard, updateBoard } from "@/lib/admin/board-actions";
import { VISIBILITY_OPTIONS } from "@/lib/admin/board-rules";
import type { Visibility } from "@/lib/db/schema/forum";

/**
 * 版块编辑。
 *
 * 一条 HIG 式的取舍：**影响面写在按钮上方，不是点完之后**。
 *
 * 收紧可见性上限会把已经发出去的帖子从别人眼前拿走。
 * 「保存成功，顺便降了 12 篇帖子」是事后通知，等于没通知 ——
 * 那 12 篇已经消失了。所以受影响的篇数和标题在保存前就摆出来。
 */

interface Props {
  board: {
    id: string;
    key: string;
    name: string;
    description: string | null;
    icon: string | null;
    visibleTo: Visibility;
    defaultVisibility: Visibility;
    maxVisibility: Visibility;
    postMinLevel: number;
    locked: boolean;
    livePosts: number;
    childCount: number;
  };
  siblings: { id: string; name: string }[];
  /** newMax -> 会被降级的帖子 */
  impacts: Record<string, { affected: number; samples: { id: string; title: string }[] }>;
}

export function BoardEditor({ board, siblings, impacts }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);

  const [name, setName] = useState(board.name);
  const [description, setDescription] = useState(board.description ?? "");
  const [icon, setIcon] = useState(board.icon ?? "");
  const [visibleTo, setVisibleTo] = useState<Visibility>(board.visibleTo);
  const [defaultVisibility, setDefaultVisibility] = useState<Visibility>(board.defaultVisibility);
  const [maxVisibility, setMaxVisibility] = useState<Visibility>(board.maxVisibility);
  const [postMinLevel, setPostMinLevel] = useState(board.postMinLevel);
  const [locked, setLocked] = useState(board.locked);
  const [reason, setReason] = useState("");

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [moveTo, setMoveTo] = useState(siblings[0]?.id ?? "");

  const impact = maxVisibility !== board.maxVisibility ? impacts[maxVisibility] : undefined;

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, success: string) => {
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        toast.show({ message: result.error ?? "操作失败", kind: "error" });
        return;
      }
      toast.show({ message: success, kind: "success" });
      setOpen(false);
      setReason("");
      router.refresh();
    });
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="t-footnote rounded-[var(--radius-pill)] bg-[var(--fill)] px-3 py-1.5 font-medium text-[var(--ink-secondary)]"
      >
        编辑
      </button>
    );
  }

  return (
    <div className="animate-rise mt-3 space-y-3 rounded-[var(--radius-card)] bg-[var(--canvas)] p-3.5">
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="名称">
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
        </Field>
        <Field label="图标（emoji）">
          <input value={icon} onChange={(e) => setIcon(e.target.value)} className={inputClass} />
        </Field>
      </div>

      <Field label="简介">
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className={inputClass}
        />
      </Field>

      <div className="grid gap-2 sm:grid-cols-3">
        <Field label="版块对谁可见">
          <Select value={visibleTo} onChange={setVisibleTo} />
        </Field>
        <Field label="新帖默认可见性">
          <Select value={defaultVisibility} onChange={setDefaultVisibility} />
        </Field>
        <Field label="可见性上限（封顶）">
          <Select value={maxVisibility} onChange={setMaxVisibility} />
        </Field>
      </div>

      {/* 影响面在保存前就摆出来。事后通知等于没通知 —— 帖子已经消失了 */}
      {impact && impact.affected > 0 && (
        <div className="rounded-[var(--radius-control)] px-3 py-2.5 hairline" style={{ background: "color-mix(in srgb, var(--warning) 10%, transparent)" }}>
          <p className="t-subhead font-medium" style={{ color: "var(--warning)" }}>
            这一改会把 {impact.affected} 篇帖子降到「
            {VISIBILITY_OPTIONS.find((o) => o.key === maxVisibility)?.label}」
          </p>
          <ul className="mt-1 space-y-0.5">
            {impact.samples.map((p) => (
              <li key={p.id} className="t-caption truncate text-[var(--ink-secondary)]">
                · {p.title}
              </li>
            ))}
            {impact.affected > impact.samples.length && (
              <li className="t-caption text-[var(--ink-tertiary)]">
                …还有 {impact.affected - impact.samples.length} 篇
              </li>
            )}
          </ul>
          <p className="t-caption2 mt-1.5 text-[var(--ink-tertiary)]">
            作者不会收到通知，他们只会发现自己的帖子别人看不到了。
          </p>
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="发帖最低等级">
          <input
            type="number"
            min={0}
            value={postMinLevel}
            onChange={(e) => setPostMinLevel(Number(e.target.value))}
            className={`tabular ${inputClass}`}
          />
        </Field>
        <label className="flex items-center gap-2 self-end pb-2">
          <input
            type="checkbox"
            checked={locked}
            onChange={(e) => setLocked(e.target.checked)}
            className="h-4 w-4"
          />
          <span className="t-subhead">锁定（禁止发新帖）</span>
        </label>
      </div>

      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="理由（必填，会记入审计日志）"
        className={inputClass}
      />

      <div className="flex gap-2">
        <button
          type="button"
          disabled={pending || !reason.trim() || !name.trim()}
          onClick={() =>
            run(
              () =>
                updateBoard({
                  id: board.id,
                  name,
                  description,
                  icon,
                  visibleTo,
                  defaultVisibility,
                  maxVisibility,
                  postMinLevel,
                  locked,
                  reason,
                }),
              impact && impact.affected > 0
                ? `已保存，${impact.affected} 篇帖子已降级`
                : "已保存",
            )
          }
          className="t-subhead flex-1 rounded-[var(--radius-control)] bg-[var(--accent)] px-4 py-2 font-medium text-[var(--accent-ink)] disabled:opacity-40"
        >
          保存
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="t-subhead rounded-[var(--radius-control)] bg-[var(--fill)] px-4 py-2 text-[var(--ink-secondary)]"
        >
          取消
        </button>
      </div>

      <details className="pt-1" onToggle={(e) => setConfirmDelete(e.currentTarget.open)}>
        <summary className="t-caption cursor-pointer list-none text-[var(--ink-tertiary)]">
          删除这个版块
        </summary>
        {confirmDelete && (
          <div className="mt-2 space-y-2">
            {board.livePosts > 0 ? (
              <>
                <p className="t-caption text-[var(--ink-secondary)]">
                  里面还有 {board.livePosts} 篇帖子，要先搬到别的版块 ——
                  直接删会让它们变成孤儿：查得到、打不开。
                </p>
                <select
                  value={moveTo}
                  onChange={(e) => setMoveTo(e.target.value)}
                  className={inputClass}
                >
                  {siblings.map((s) => (
                    <option key={s.id} value={s.id}>
                      搬到「{s.name}」
                    </option>
                  ))}
                </select>
              </>
            ) : (
              <p className="t-caption text-[var(--ink-tertiary)]">这个版块是空的，可以直接删。</p>
            )}
            <button
              type="button"
              disabled={pending || !reason.trim() || (board.livePosts > 0 && !moveTo)}
              onClick={() =>
                run(
                  () =>
                    deleteBoard({
                      id: board.id,
                      moveTo: board.livePosts > 0 ? moveTo : undefined,
                      reason,
                    }),
                  "已删除",
                )
              }
              className="t-subhead w-full rounded-[var(--radius-control)] px-4 py-2 font-medium disabled:opacity-40"
              style={{ background: "color-mix(in srgb, var(--danger) 12%, transparent)", color: "var(--danger)" }}
            >
              确认删除（需要先填理由）
            </button>
          </div>
        )}
      </details>
    </div>
  );
}

const inputClass =
  "t-subhead w-full rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 outline-none placeholder:text-[var(--ink-quaternary)]";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="t-caption2 mb-1 block text-[var(--ink-quaternary)]">{label}</span>
      {children}
    </label>
  );
}

function Select({
  value,
  onChange,
}: {
  value: Visibility;
  onChange: (v: Visibility) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as Visibility)}
      className={inputClass}
    >
      {VISIBILITY_OPTIONS.map((option) => (
        <option key={option.key} value={option.key}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
