"use client";

import { EyeOff, Pencil, Quote, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { SwipeRow } from "@/components/ui/SwipeRow";
import { useToast } from "@/components/ui/Toast";
import { deleteMyReply, restoreMyReply } from "@/lib/forum/undo";

import { useQuote } from "./QuoteContext";
import { moderateReply } from "@/lib/forum/moderation";
import { editReply } from "@/lib/forum/actions";

/**
 * 回复行的手势与操作。
 *
 * 删除**不弹确认框** —— 直接执行，底部给「已删除 · 撤销」，
 * 6 秒内可恢复。确认框会让人养成无脑点确定的习惯，
 * 真正危险的操作反而被忽略。
 */
export function ReplyRow({
  replyId,
  floor,
  authorName,
  isMine,
  content,
  canEdit,
  canModerate,
  children,
}: {
  replyId: string;
  floor: number;
  authorName: string;
  isMine: boolean;
  /** 原文（markdown）。编辑时要拿它填输入框 —— 渲染后的 HTML 回不去 */
  content: string;
  /** 作者本人 + 还在可改的时间窗内。判定在服务端做，这里只管显示 */
  canEdit: boolean;
  /** 版主或楼主 —— 能折叠别人的回复 */
  canModerate: boolean;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const toast = useToast();
  const quoteCtx = useQuote();
  const [, startTransition] = useTransition();
  const [removed, setRemoved] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  /*
   * 折叠要填理由，所以是「先展开一个输入框」而不是直接执行。
   *
   * 一条没有理由的折叠，和版主随手删人没有区别 ——
   * 被折叠的人看不到为什么，只会觉得被针对了。
   */
  const [collapsing, setCollapsing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const remove = () => {
    // 先在本地隐藏，请求在后台发 —— 等服务端回来再消失会有明显延迟
    setRemoved(true);
    startTransition(async () => {
      const result = await deleteMyReply(replyId);
      if (!result.ok) {
        setRemoved(false);
        toast.show({ message: result.error ?? "删除失败", kind: "error" });
        return;
      }
      toast.show({
        message: "回复已删除",
        undo: async () => {
          const restored = await restoreMyReply(replyId);
          if (restored.ok) {
            setRemoved(false);
            router.refresh();
          } else {
            toast.show({ message: restored.error ?? "恢复失败", kind: "error" });
          }
        },
      });
      router.refresh();
    });
  };

  const saveEdit = () => {
    if (editing === null) return;
    setBusy(true);
    startTransition(async () => {
      const result = await editReply({ replyId, content: editing });
      setBusy(false);
      if (!result.ok) {
        toast.show({ message: result.error ?? "保存失败", kind: "error" });
        return;
      }
      setEditing(null);
      toast.show({ message: "已保存 —— 这条会标上「编辑过」" });
      router.refresh();
    });
  };

  const doCollapse = () => {
    if (collapsing === null) return;
    setBusy(true);
    startTransition(async () => {
      const result = await moderateReply({ replyId, action: "collapse", reason: collapsing });
      setBusy(false);
      if (!result.ok) {
        toast.show({ message: result.error ?? "折叠失败", kind: "error" });
        return;
      }
      setCollapsing(null);
      toast.show({ message: "已折叠 —— 原文还在，点开还能看" });
      router.refresh();
    });
  };

  if (removed) return null;

  if (editing !== null) {
    return (
      <div className="inset-row px-4 py-3.5">
        <textarea
          value={editing}
          onChange={(e) => setEditing(e.target.value)}
          rows={4}
          autoFocus
          aria-label={`编辑 ${floor} 楼的回复`}
          className="t-body w-full rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2.5 leading-relaxed outline-none"
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={saveEdit}
            disabled={busy}
            className="t-footnote rounded-[var(--radius-control)] bg-[var(--accent)] px-3 py-2 font-medium text-[var(--accent-ink)] transition active:scale-[0.98] disabled:opacity-40"
          >
            {busy ? "保存中…" : "保存"}
          </button>
          <button
            type="button"
            onClick={() => setEditing(null)}
            className="t-footnote rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 transition active:scale-[0.98]"
          >
            取消
          </button>
          <span className="t-caption2 text-[var(--ink-tertiary)]">
            改完会标上「编辑过」—— 底下可能已经有人在回应它
          </span>
        </div>
      </div>
    );
  }

  if (collapsing !== null) {
    return (
      <div className="inset-row px-4 py-3.5">
        <p className="t-subhead mb-2">折叠 {floor} 楼</p>
        <input
          value={collapsing}
          onChange={(e) => setCollapsing(e.target.value)}
          autoFocus
          aria-label="折叠理由"
          placeholder="理由（会显示给所有人看）"
          className="t-body w-full rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 outline-none placeholder:text-[var(--ink-quaternary)]"
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={doCollapse}
            disabled={busy || !collapsing.trim()}
            className="t-footnote rounded-[var(--radius-control)] bg-[var(--accent)] px-3 py-2 font-medium text-[var(--accent-ink)] transition active:scale-[0.98] disabled:opacity-40"
          >
            {busy ? "折叠中…" : "折叠"}
          </button>
          <button
            type="button"
            onClick={() => setCollapsing(null)}
            className="t-footnote rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 transition active:scale-[0.98]"
          >
            取消
          </button>
          <span className="t-caption2 text-[var(--ink-tertiary)]">
            折叠不是删除 —— 原文还在，谁都能点开看
          </span>
        </div>
      </div>
    );
  }

  const actions = [
    // 没有 Provider（未登录 / 帖子已锁）就不给引用入口
    ...(quoteCtx
      ? [
          {
            label: "引用",
            icon: <Quote className="h-4 w-4" strokeWidth={2} aria-hidden />,
            run: () => quoteCtx.setQuote({ replyId, floor, authorName }),
          },
        ]
      : []),
    ...(canEdit
      ? [
          {
            label: "编辑",
            icon: <Pencil className="h-4 w-4" strokeWidth={2} aria-hidden />,
            run: () => setEditing(content),
          },
        ]
      : []),
    ...(canModerate && !isMine
      ? [
          {
            label: "折叠",
            icon: <EyeOff className="h-4 w-4" strokeWidth={2} aria-hidden />,
            run: () => setCollapsing(""),
          },
        ]
      : []),
    ...(isMine
      ? [
          {
            label: "删除",
            icon: <Trash2 className="h-4 w-4" strokeWidth={2} aria-hidden />,
            danger: true,
            run: remove,
          },
        ]
      : []),
  ];

  return <SwipeRow actions={actions}>{children}</SwipeRow>;
}
