"use client";

import { Quote, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { SwipeRow } from "@/components/ui/SwipeRow";
import { useToast } from "@/components/ui/Toast";
import { deleteMyReply, restoreMyReply } from "@/lib/forum/undo";

import { useQuote } from "./QuoteContext";

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
  children,
}: {
  replyId: string;
  floor: number;
  authorName: string;
  isMine: boolean;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const toast = useToast();
  const quoteCtx = useQuote();
  const [, startTransition] = useTransition();
  const [removed, setRemoved] = useState(false);

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

  if (removed) return null;

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
