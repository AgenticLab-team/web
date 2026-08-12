"use client";

import { ChevronDown, ChevronUp, FolderPlus, Pencil, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  createFolder,
  deleteFolder,
  renameFolder,
  reorderFolders,
} from "@/lib/forum/bookmark-actions";
import { MAX_FOLDERS, MAX_FOLDER_NAME, UNSORTED_NAME } from "@/lib/forum/bookmark-rules";

/**
 * 收藏夹的增删改排。
 *
 * ─────────────────────────────────────────
 * 排序用上下箭头，不用拖拽
 * ─────────────────────────────────────────
 *
 * 拖拽在手机上要和页面滚动抢手势，在读屏下基本没法用，
 * 而这里最多 20 项、而且几乎不重排。两个箭头键盘能按、
 * 读屏能念、手机上也是个正常的可点区域 ——
 * 「手机端电脑端都要有」在这种地方就是别用只有鼠标才顺手的交互。
 */
export function FolderManager({
  folders,
}: {
  folders: { id: string; name: string; count: number }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) setError(r.error ?? "没成功");
      else {
        setError(null);
        router.refresh();
      }
    });

  const move = (index: number, delta: number) => {
    const next = [...folders];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    run(() => reorderFolders(next.map((f) => f.id)));
  };

  return (
    <div className="inset-group">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inset-row flex w-full items-center gap-2 px-4 py-3 transition-colors hover:bg-[var(--fill)]"
      >
        <FolderPlus className="h-4 w-4 text-[var(--ink-tertiary)]" strokeWidth={2} aria-hidden />
        <span className="t-body flex-1 text-left">管理收藏夹</span>
        <span className="t-footnote text-[var(--ink-tertiary)]">
          {folders.length}/{MAX_FOLDERS}
        </span>
        <ChevronDown
          className={`h-4 w-4 text-[var(--ink-quaternary)] transition-transform ${open ? "rotate-180" : ""}`}
          strokeWidth={2}
          aria-hidden
        />
      </button>

      {open && (
        <div className="px-4 py-3">
          <div className="flex items-center gap-2">
            <input
              value={creating}
              onChange={(e) => setCreating(e.target.value)}
              maxLength={MAX_FOLDER_NAME}
              placeholder="新收藏夹的名字"
              className="t-footnote min-w-0 flex-1 rounded-[var(--radius-control)] border border-[var(--separator)] bg-[var(--canvas)] px-2.5 py-2 outline-none focus:border-[var(--accent)]"
            />
            <button
              type="button"
              disabled={pending || !creating.trim()}
              onClick={() =>
                run(async () => {
                  const r = await createFolder(creating);
                  if (r.ok) setCreating("");
                  return r;
                })
              }
              className="t-caption shrink-0 rounded-[var(--radius-control)] bg-[var(--accent)] px-3 py-2 font-medium text-[var(--accent-ink)] transition active:scale-95 disabled:opacity-40"
            >
              建一个
            </button>
          </div>

          {folders.length > 0 && (
            <ul className="mt-3 space-y-1">
              {folders.map((folder, i) => (
                <li key={folder.id} className="flex items-center gap-1.5">
                  {renaming?.id === folder.id ? (
                    <>
                      <input
                        value={renaming.name}
                        onChange={(e) => setRenaming({ id: folder.id, name: e.target.value })}
                        maxLength={MAX_FOLDER_NAME}
                        autoFocus
                        aria-label={`「${folder.name}」的新名字`}
                        className="t-footnote min-w-0 flex-1 rounded-[var(--radius-control)] border border-[var(--separator)] bg-[var(--canvas)] px-2 py-1.5 outline-none focus:border-[var(--accent)]"
                      />
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          run(async () => {
                            const r = await renameFolder(folder.id, renaming.name);
                            if (r.ok) setRenaming(null);
                            return r;
                          })
                        }
                        className="t-caption shrink-0 rounded-[var(--radius-control)] bg-[var(--fill)] px-2 py-1.5"
                      >
                        改好了
                      </button>
                      <button
                        type="button"
                        onClick={() => setRenaming(null)}
                        className="t-caption shrink-0 px-1.5 text-[var(--ink-tertiary)]"
                      >
                        取消
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="t-footnote min-w-0 flex-1 truncate">{folder.name}</span>
                      <span className="tabular t-caption text-[var(--ink-quaternary)]">
                        {folder.count}
                      </span>

                      <IconBtn
                        label="往上挪"
                        disabled={pending || i === 0}
                        onClick={() => move(i, -1)}
                      >
                        <ChevronUp className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                      </IconBtn>
                      <IconBtn
                        label="往下挪"
                        disabled={pending || i === folders.length - 1}
                        onClick={() => move(i, 1)}
                      >
                        <ChevronDown className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                      </IconBtn>
                      <IconBtn
                        label="改名"
                        disabled={pending}
                        onClick={() => setRenaming({ id: folder.id, name: folder.name })}
                      >
                        <Pencil className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                      </IconBtn>
                      <IconBtn label="删掉" disabled={pending} onClick={() => setConfirming(folder.id)}>
                        <Trash2 className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                      </IconBtn>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}

          {/*
            * 删除前说清楚里面的收藏会怎么样。
            *
            * 不说的话，「删收藏夹」看起来就像「删掉里面攒的那些东西」——
            * 于是没人敢删，那个功能等于不存在。
            */}
          {confirming && (
            <div className="mt-3 rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2.5">
              <p className="t-footnote text-[var(--ink-secondary)]">
                删掉「{folders.find((f) => f.id === confirming)?.name}」。
                里面的 {folders.find((f) => f.id === confirming)?.count ?? 0} 条收藏
                <b className="font-medium text-[var(--ink)]">不会丢</b>，会挪回「{UNSORTED_NAME}」。
              </p>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    run(async () => {
                      const r = await deleteFolder(confirming);
                      if (r.ok) setConfirming(null);
                      return r;
                    })
                  }
                  className="t-caption rounded-[var(--radius-control)] bg-[var(--danger)] px-3 py-1.5 font-medium text-[var(--danger-ink)] transition active:scale-95 disabled:opacity-50"
                >
                  删掉
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(null)}
                  className="t-caption px-2 py-1.5 text-[var(--ink-tertiary)]"
                >
                  算了
                </button>
              </div>
            </div>
          )}

          {error && <p className="t-caption mt-2 text-[var(--danger)]">{error}</p>}
        </div>
      )}
    </div>
  );
}

function IconBtn({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      // min-h-8 min-w-8：这一排图标在手机上挨得很近，再小就点不准了
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-[var(--ink-tertiary)] transition hover:bg-[var(--fill)] active:scale-90 disabled:opacity-30"
    >
      {children}
    </button>
  );
}
