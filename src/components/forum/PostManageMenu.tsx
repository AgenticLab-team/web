"use client";

import {
  ArrowRightLeft,
  Ellipsis,
  Lock,
  LockOpen,
  Pencil,
  Pin,
  PinOff,
  RotateCcw,
  Star,
  StarOff,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";

import { panelStyles, useAnchoredPanel } from "@/components/ui/anchored";

import { useToast } from "@/components/ui/Toast";
import { moderatePost, movePost } from "@/lib/forum/moderation";
import { deleteMyPost, restoreMyPost } from "@/lib/forum/undo";

/**
 * 帖子页的统一管理菜单：作者与版主的所有帖子级操作都收在这一个入口里。
 *
 * 为什么收进一个菜单而不是摆一排按钮：管理动作对多数读者是噪音，
 * 摆出来会把「回复、点赞」这些主操作挤到看不见的地方 ——
 * 布局割裂感就是这么来的。
 *
 * 这里的 caps 只决定**显示**，不是授权：每个 server action
 * 拿到请求后都会用 can() 重新判一遍，客户端传什么都不被信任。
 */
export interface PostMenuCaps {
  edit: boolean;
  deleteOwn: boolean;
  deleteAny: boolean;
  restore: boolean;
  feature: boolean;
  pin: boolean;
  lock: boolean;
  move: boolean;
}

interface BoardOption {
  id: string;
  name: string;
}

/** 需要版主填理由的第二步；null 表示还在主菜单 */
type Step = null | { kind: "reason"; action: "lock" | "delete" } | { kind: "move" };

export function PostManageMenu({
  postId,
  boardKey,
  status,
  pinned,
  featured,
  caps,
  boards,
}: {
  postId: string;
  boardKey: string;
  status: string;
  pinned: boolean;
  featured: boolean;
  caps: PostMenuCaps;
  boards: BoardOption[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>(null);
  const [reason, setReason] = useState("");
  const [targetBoard, setTargetBoard] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  /*
   * 面板传送到 body。
   *
   * 帖子那个 <article> 因为 animate-rise 里的 transform 成了层叠上下文，
   * 菜单的 z-40 出不去，被 DOM 顺序更靠后的回复列表盖住 ——
   * 这是站长报的「更多菜单会被底下的回复挡住」。
   * z-index 调多大都没用，只能不待在那个上下文里。
   */
  const anchorRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const anchored = useAnchoredPanel(open, anchorRef, panelRef, "end");

  const close = useCallback(() => {
    setOpen(false);
    setStep(null);
    setReason("");
    setTargetBoard("");
  }, []);

  // 点外面关掉；Escape 关掉 —— 菜单关不上比打不开更让人烦躁
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  const runModeration = (
    action: "feature" | "unfeature" | "pin" | "unpin" | "lock" | "unlock" | "delete" | "restore",
    reasonText: string,
    doneMessage: string,
  ) => {
    startTransition(async () => {
      const result = await moderatePost({ postId, action, reason: reasonText });
      if (!result.ok) {
        toast.show({ message: result.error ?? "操作失败", kind: "error" });
        return;
      }
      toast.show({ message: doneMessage, kind: "success" });
      close();
      router.refresh();
    });
  };

  /**
   * 自删不弹确认框：立即执行 + 撤销窗口。
   * 删掉后自己也看不到这一页了，所以先跳回版块，撤销时再跳回来。
   */
  const deleteOwn = () => {
    close();
    startTransition(async () => {
      const result = await deleteMyPost(postId);
      if (!result.ok) {
        toast.show({ message: result.error ?? "删除失败", kind: "error" });
        return;
      }
      router.replace(`/forum/${boardKey}`);
      toast.show({
        message: "帖子已删除",
        undo: async () => {
          const restored = await restoreMyPost(postId);
          if (restored.ok) {
            router.push(`/forum/p/${postId}`);
          } else {
            toast.show({ message: restored.error ?? "恢复失败", kind: "error" });
          }
        },
      });
    });
  };

  const submitMove = () => {
    if (!targetBoard) return;
    startTransition(async () => {
      const result = await movePost({ postId, toBoardId: targetBoard, reason });
      if (!result.ok) {
        toast.show({ message: result.error ?? "移动失败", kind: "error" });
        return;
      }
      toast.show({ message: "已移动版块", kind: "success" });
      close();
      router.refresh();
    });
  };

  const submitReason = () => {
    if (step?.kind !== "reason" || !reason.trim()) return;
    if (step.action === "lock") {
      runModeration("lock", reason, "已锁定");
    } else {
      runModeration("delete", reason, "已删除，可在此页恢复");
    }
  };

  const locked = status === "locked";
  const deleted = status === "deleted";

  const anyCap = Object.values(caps).some(Boolean);
  if (!anyCap) return null;

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={anchorRef}
        type="button"
        aria-label="帖子管理操作"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => (open ? close() : setOpen(true))}
        className={`tap-target rounded-[0.5rem] p-2 transition active:scale-90 ${
          open
            ? "bg-[var(--fill)] text-[var(--ink)]"
            : "text-[var(--ink-tertiary)] hover:bg-[var(--fill)] hover:text-[var(--ink-secondary)]"
        }`}
      >
        <Ellipsis className="h-4 w-4" strokeWidth={1.9} aria-hidden />
      </button>

      {/*
        * 手机上贴底（让开 tab 栏与安全区），桌面上锚在按钮下方 ——
        * 排布在 panelStyles 里，两种共用一处。
        * 面板整个传送到 body，所以不受任何祖先的层叠上下文影响。
        */}
      {open &&
        anchored.mounted &&
        createPortal(
          <>
            {anchored.narrow && (
              <div
                className="animate-fade fixed inset-0 z-[90] bg-black/25"
                onPointerDown={close}
                aria-hidden
              />
            )}
            <div ref={panelRef} {...panelStyles({ narrow: anchored.narrow, position: anchored.position })}>
          {step === null && (
            <div className="flex flex-col">
              {caps.edit && (
                <MenuLink href={`/forum/p/${postId}/edit`} icon={Pencil} label="编辑帖子" />
              )}

              {caps.feature &&
                (featured ? (
                  <MenuItem
                    icon={StarOff}
                    label="取消加精"
                    disabled={pending}
                    onClick={() => runModeration("unfeature", "快捷操作", "已取消加精")}
                  />
                ) : (
                  <MenuItem
                    icon={Star}
                    label="加精"
                    disabled={pending}
                    onClick={() => runModeration("feature", "快捷操作", "已加精")}
                  />
                ))}

              {caps.pin &&
                (pinned ? (
                  <MenuItem
                    icon={PinOff}
                    label="取消置顶"
                    disabled={pending}
                    onClick={() => runModeration("unpin", "快捷操作", "已取消置顶")}
                  />
                ) : (
                  <MenuItem
                    icon={Pin}
                    label="置顶"
                    disabled={pending}
                    onClick={() => runModeration("pin", "快捷操作", "已置顶")}
                  />
                ))}

              {caps.lock &&
                (locked ? (
                  <MenuItem
                    icon={LockOpen}
                    label="解除锁定"
                    disabled={pending}
                    onClick={() => runModeration("unlock", "快捷操作", "已解锁")}
                  />
                ) : (
                  <MenuItem
                    icon={Lock}
                    label="锁定回复"
                    disabled={pending}
                    onClick={() => setStep({ kind: "reason", action: "lock" })}
                  />
                ))}

              {caps.move && boards.length > 0 && (
                <MenuItem
                  icon={ArrowRightLeft}
                  label="移动版块"
                  disabled={pending}
                  onClick={() => setStep({ kind: "move" })}
                />
              )}

              {caps.restore && deleted && (
                <MenuItem
                  icon={RotateCcw}
                  label="恢复帖子"
                  disabled={pending}
                  onClick={() => runModeration("restore", "恢复误删内容", "已恢复")}
                />
              )}

              {caps.deleteOwn && (
                <MenuItem icon={Trash2} label="删除" danger disabled={pending} onClick={deleteOwn} />
              )}

              {caps.deleteAny && (
                <MenuItem
                  icon={Trash2}
                  label="删除（管理）"
                  danger
                  disabled={pending}
                  onClick={() => setStep({ kind: "reason", action: "delete" })}
                />
              )}
            </div>
          )}

          {step?.kind === "reason" && (
            <div className="p-2">
              <p className="t-subhead mb-2 font-medium">
                {step.action === "lock" ? "锁定回复" : "删除这篇帖子"}
              </p>
              {/*
               * 处罚必须填理由 —— 不是走形式：作者会收到带理由的通知，
               * 申诉时也全凭这一句判断当初对错。
               */}
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                autoFocus
                aria-label="操作理由"
                placeholder="理由（作者会看到）"
                className="t-footnote w-full resize-none rounded-[var(--radius-control)] bg-[var(--fill)] px-2.5 py-2 outline-none placeholder:text-[var(--ink-quaternary)]"
              />
              <div className="mt-2 flex gap-1.5">
                <button
                  type="button"
                  disabled={pending || !reason.trim()}
                  onClick={submitReason}
                  className={`t-footnote flex-1 rounded-[var(--radius-control)] px-3 py-2 font-medium transition active:scale-[0.98] disabled:opacity-40 ${
                    step.action === "delete"
                      ? "bg-[var(--danger)] text-white"
                      : "bg-[var(--accent)] text-[var(--accent-ink)]"
                  }`}
                >
                  {step.action === "lock" ? "锁定" : "删除"}
                </button>
                <button
                  type="button"
                  onClick={() => setStep(null)}
                  className="t-footnote rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 transition active:scale-[0.98]"
                >
                  返回
                </button>
              </div>
            </div>
          )}

          {step?.kind === "move" && (
            <div className="p-2">
              <p className="t-subhead mb-2 font-medium">移到哪个版块</p>
              <div className="flex max-h-48 flex-col gap-1 overflow-y-auto">
                {boards.map((b) => (
                  <label
                    key={b.id}
                    className={`t-footnote flex cursor-pointer items-center gap-2 rounded-[var(--radius-control)] px-2.5 py-2 transition ${
                      targetBoard === b.id
                        ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                        : "hover:bg-[var(--fill)]"
                    }`}
                  >
                    <input
                      type="radio"
                      name="move-target"
                      checked={targetBoard === b.id}
                      onChange={() => setTargetBoard(b.id)}
                      className="accent-[var(--accent)]"
                    />
                    {b.name}
                  </label>
                ))}
              </div>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                aria-label="移动理由（可选）"
                placeholder="理由（可选）"
                className="t-footnote mt-2 w-full rounded-[var(--radius-control)] bg-[var(--fill)] px-2.5 py-2 outline-none placeholder:text-[var(--ink-quaternary)]"
              />
              <div className="mt-2 flex gap-1.5">
                <button
                  type="button"
                  disabled={pending || !targetBoard}
                  onClick={submitMove}
                  className="t-footnote flex-1 rounded-[var(--radius-control)] bg-[var(--accent)] px-3 py-2 font-medium text-[var(--accent-ink)] transition active:scale-[0.98] disabled:opacity-40"
                >
                  移动
                </button>
                <button
                  type="button"
                  onClick={() => setStep(null)}
                  className="t-footnote rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 transition active:scale-[0.98]"
                >
                  返回
                </button>
              </div>
            </div>
          )}
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}

function MenuItem({
  icon: Icon,
  label,
  onClick,
  danger = false,
  disabled = false,
}: {
  icon: typeof Pencil;
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`t-subhead flex items-center gap-2.5 rounded-[var(--radius-control)] px-3 py-2.5 text-left transition hover:bg-[var(--fill)] disabled:opacity-40 ${
        danger ? "text-[var(--danger)]" : "text-[var(--ink)]"
      }`}
    >
      <Icon className="h-4 w-4 shrink-0" strokeWidth={1.9} aria-hidden />
      {label}
    </button>
  );
}

function MenuLink({
  icon: Icon,
  label,
  href,
}: {
  icon: typeof Pencil;
  label: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="t-subhead flex items-center gap-2.5 rounded-[var(--radius-control)] px-3 py-2.5 text-[var(--ink)] transition hover:bg-[var(--fill)]"
    >
      <Icon className="h-4 w-4 shrink-0" strokeWidth={1.9} aria-hidden />
      {label}
    </Link>
  );
}
