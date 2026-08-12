"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  AdminActions,
  AdminButton,
  AdminChip,
  AdminNote,
  adminFieldClass,
} from "@/components/admin/ui";
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
    allowAnonymous: boolean;
    requireTags: boolean;
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
  const [allowAnonymous, setAllowAnonymous] = useState(board.allowAnonymous);
  const [requireTags, setRequireTags] = useState(board.requireTags);
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
      <AdminChip aria-expanded={false} onClick={() => setOpen(true)}>
        编辑
      </AdminChip>
    );
  }

  return (
    <div className="animate-rise mt-3 space-y-3 rounded-[var(--radius-card)] bg-[var(--canvas)] p-3.5">
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="名称">
          <input value={name} onChange={(e) => setName(e.target.value)} className={adminFieldClass} />
        </Field>
        <Field label="图标（emoji）">
          <input value={icon} onChange={(e) => setIcon(e.target.value)} className={adminFieldClass} />
        </Field>
      </div>

      <Field label="简介">
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className={adminFieldClass}
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
            className={`tabular ${adminFieldClass}`}
          />
        </Field>
        <label className="flex min-h-11 items-center gap-2.5 self-end pb-2">
          <input
            type="checkbox"
            checked={locked}
            onChange={(e) => setLocked(e.target.checked)}
            className="h-5 w-5 shrink-0 accent-[var(--accent)]"
          />
          <span className="t-subhead">锁定（禁止发新帖）</span>
        </label>

        {/*
          * 这两个开关的列在 schema 里躺了很久，后台一直没法改 ——
          * 也就是说 `allow_anonymous` 永远是 false（匿名功能等于不存在），
          * `require_tags` 永远是 false。
          */}
        <label className="flex min-h-11 items-center gap-2.5">
          <input
            type="checkbox"
            checked={allowAnonymous}
            onChange={(e) => setAllowAnonymous(e.target.checked)}
            className="h-5 w-5 shrink-0 accent-[var(--accent)]"
          />
          <span className="t-subhead">允许匿名发帖与回复</span>
        </label>

        <label className="flex min-h-11 items-center gap-2.5">
          <input
            type="checkbox"
            checked={requireTags}
            onChange={(e) => setRequireTags(e.target.checked)}
            className="h-5 w-5 shrink-0 accent-[var(--accent)]"
          />
          <span className="t-subhead">发帖必须打标签</span>
        </label>
      </div>

      {allowAnonymous && (
        /*
          * 开之前要说清楚匿名管到哪儿。不说的话，管理员会以为
          * 自己也查不到，于是**该开的时候不敢开**；
          * 而用户那一侧则可能以为连管理员都看不见。两头都要说。
          */
        <p className="t-caption2 leading-relaxed text-[var(--ink-tertiary)]">
          匿名是对其他用户的：后台的帖子列表里仍然显示真实作者，并标着「匿名发布」——
          否则处理纠纷时连是谁发的都查不到。
        </p>
      )}

      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="理由（必填，会记入审计日志）"
        className={adminFieldClass}
      />

      <AdminActions>
        {/* 收紧可见性会把已发出去的帖子从别人眼前拿走 —— 那一档归 danger。
            普通改名改简介是 primary。同一个按钮按后果换档，
            比常年一个绿色「保存」诚实 */}
        <AdminButton
          tone={impact && impact.affected > 0 ? "danger" : "primary"}
          className="flex-1"
          disabled={pending || !reason.trim() || !name.trim()}
          title={reason.trim() ? undefined : "先写一句理由"}
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
                  allowAnonymous,
                  requireTags,
                  reason,
                }),
              impact && impact.affected > 0
                ? `已保存，${impact.affected} 篇帖子已降级`
                : "已保存",
            )
          }
        >
          {impact && impact.affected > 0 ? `保存并降级 ${impact.affected} 篇` : "保存"}
        </AdminButton>
        <AdminButton tone="quiet" onClick={() => setOpen(false)}>
          取消
        </AdminButton>
      </AdminActions>

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
                  aria-label="把里面的帖子搬到哪个版块"
                  className={adminFieldClass}
                >
                  {siblings.map((s) => (
                    <option key={s.id} value={s.id}>
                      搬到「{s.name}」
                    </option>
                  ))}
                </select>
              </>
            ) : (
              <AdminNote className="px-0">这个版块是空的，可以直接删。</AdminNote>
            )}
            {/* 删版块不可逆 —— 实心红。原来是 12% 淡红底，
                和「退款」那种撤得回来的动作长得一样 */}
            <AdminButton
              tone="danger"
              block
              disabled={pending || !reason.trim() || (board.livePosts > 0 && !moveTo)}
              title={reason.trim() ? undefined : "先在上面填一句理由"}
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
            >
              {board.livePosts > 0
                ? `搬走 ${board.livePosts} 篇并删掉这个版块`
                : "确认删除这个版块"}
            </AdminButton>
          </div>
        )}
      </details>
    </div>
  );
}

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
      className={adminFieldClass}
    >
      {VISIBILITY_OPTIONS.map((option) => (
        <option key={option.key} value={option.key}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
