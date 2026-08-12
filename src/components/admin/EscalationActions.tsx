"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  AdminActions,
  AdminBlocked,
  AdminButton,
  AdminNote,
  adminFieldClass,
} from "@/components/admin/ui";
import { useToast } from "@/components/ui/Toast";
import { approveEscalation, rejectEscalation } from "@/lib/admin/escalation-actions";

/**
 * 可见性提升的处置。
 *
 * 「通过」和「驳回」不做主次色差。通过之后内容立刻扩散，
 * 而扩散是**不可逆的** —— 事后撤回撤不掉别人已经看到的东西。
 * 把通过做成醒目的主按钮，等于在界面上鼓励点它。
 *
 * 同意没凑齐时通过按钮直接禁用并说明还差几位，
 * 而不是点下去才被拒绝 —— 那会让人以为是系统出错。
 */
export function EscalationActions({
  id,
  blocked,
  consentMissing,
}: {
  id: string;
  /** 不为空表示当前管理员不能处理这条 */
  blocked: string | null;
  consentMissing: number;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState("");

  if (blocked) return <AdminBlocked>{blocked}</AdminBlocked>;

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, success: string) => {
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        toast.show({ message: result.error ?? "操作失败", kind: "error" });
        return;
      }
      toast.show({ message: success, kind: "success" });
      setNote("");
      router.refresh();
    });
  };

  return (
    <div className="space-y-2">
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        placeholder="理由（必填，申请人会看到）"
        className={`resize-none ${adminFieldClass}`}
      />

      {/* 两个都用 neutral：通过之后扩散不可逆，把它做成醒目的主按钮
          等于在界面上鼓励点它。这一条是刻意的 —— 见文件头 */}
      <AdminActions>
        <AdminButton
          tone="neutral"
          className="flex-1"
          disabled={pending || !note.trim() || consentMissing > 0}
          title={
            consentMissing > 0
              ? `还差 ${consentMissing} 位原作者同意，不能通过`
              : "通过后内容立刻对更多人可见，不可撤回"
          }
          onClick={() => run(() => approveEscalation({ id, note }), "已通过，内容已提升可见性")}
        >
          {consentMissing > 0 ? `还差 ${consentMissing} 位同意` : "通过"}
        </AdminButton>
        <AdminButton
          tone="neutral"
          className="flex-1"
          disabled={pending || !note.trim()}
          onClick={() => run(() => rejectEscalation({ id, note }), "已驳回并答复申请人")}
        >
          维持现状
        </AdminButton>
      </AdminActions>

      <AdminNote className="px-0">
        通过之后内容会立刻对更多人可见，<strong>扩散不可逆</strong> ——
        事后撤回撤不掉别人已经看到的东西。拿不准就先驳回，让申请人补充说明。
      </AdminNote>
    </div>
  );
}
