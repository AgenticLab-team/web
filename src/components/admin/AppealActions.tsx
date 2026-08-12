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
import { handleAppeal } from "@/lib/forum/appeals";

/**
 * 申诉处理。
 *
 * 「采纳」和「驳回」两个按钮**长得一样重**，没有主次色差 ——
 * 把驳回做成默认选项，等于在界面上暗示应该驳回。
 *
 * 原处罚人不能复核自己的决定：这条在渲染时就说明白，
 * 按钮直接不出现，而不是点下去才被拒绝。
 */

interface Props {
  appealId: string;
  /** 不为空表示当前管理员不能处理这条，内容是原因 */
  blocked: string | null;
}

export function AppealActions({ appealId, blocked }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [response, setResponse] = useState("");

  if (blocked) return <AdminBlocked>{blocked}</AdminBlocked>;

  const submit = (accept: boolean) => {
    startTransition(async () => {
      const result = await handleAppeal({ appealId, accept, response });
      if (!result.ok) toast.show({ message: result.error ?? "操作失败", kind: "error" });
      else {
        toast.show({ message: accept ? "已采纳并撤销处罚" : "已答复申诉人", kind: "success" });
        setResponse("");
        router.refresh();
      }
    });
  };

  return (
    <div className="space-y-2">
      <textarea
        value={response}
        onChange={(e) => setResponse(e.target.value)}
        rows={2}
        placeholder="答复（必填，会原样发给申诉人）"
        className={`resize-none ${adminFieldClass}`}
      />
      {/* 两个都用 neutral：把其中一个做成主色，等于在界面上暗示该选它。
          这一条是刻意的，不是漏了上色 —— 见文件头 */}
      <AdminActions>
        <AdminButton
          tone="neutral"
          className="flex-1"
          disabled={pending || !response.trim()}
          onClick={() => submit(true)}
        >
          采纳，撤销处罚
        </AdminButton>
        <AdminButton
          tone="neutral"
          className="flex-1"
          disabled={pending || !response.trim()}
          onClick={() => submit(false)}
        >
          维持原判
        </AdminButton>
      </AdminActions>
      <AdminNote className="px-0">
        采纳会把这条处罚标记为已撤销，用户档案上看得出这次是误判。
      </AdminNote>
    </div>
  );
}
