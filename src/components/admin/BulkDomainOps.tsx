"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";

import { useToast } from "@/components/ui/Toast";
import {
  commitBulkFulfill,
  previewBulkFulfill,
  type BulkCommitResult,
} from "@/lib/activities/actions";
import type { BulkPlan } from "@/lib/activities/bulk-fulfill";

/**
 * 域名活动的批量操作：导出注册列表 + 粘贴回填结果。
 *
 * 这两块拼的是同一条工作流的去程和回程 ——
 * 管理员复制一份列表去注册商那边，注册完把结果粘回来。
 */

// ── 去程：导出 ────────────────────────────────────────────────

export function RegistrarExport({ pending, all }: { pending: string; all: string }) {
  const toast = useToast();
  const [scope, setScope] = useState<"pending" | "all">("pending");
  const taRef = useRef<HTMLTextAreaElement>(null);

  const text = scope === "pending" ? pending : all;
  const count = text ? text.split("\n").length : 0;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast.show({ message: `已复制 ${count} 个域名`, kind: "success" });
    } catch {
      /*
       * 微信内置浏览器经常拿不到 clipboard-write 权限。
       * 降级路径必须存在，否则管理员在手机上会卡死在这一步：
       * 全选文本框再走一次老式复制，还不行就让他自己长按。
       */
      taRef.current?.focus();
      taRef.current?.select();
      let copied = false;
      try {
        copied = document.execCommand("copy");
      } catch {
        copied = false;
      }
      toast.show(
        copied
          ? { message: `已复制 ${count} 个域名`, kind: "success" }
          : { message: "复制不了 —— 文本框已全选，长按手动复制", kind: "error" },
      );
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {(
          [
            ["pending", "只导没处理过的"],
            ["all", "全部"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setScope(value)}
            className={`t-caption rounded-[var(--radius-pill)] px-2.5 py-1 ${
              scope === value
                ? "bg-[var(--accent)] font-medium text-white"
                : "bg-[var(--fill)] text-[var(--ink-secondary)]"
            }`}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          disabled={count === 0}
          onClick={copy}
          className="t-caption ml-auto rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-1 font-medium text-[var(--accent)] disabled:opacity-40"
        >
          复制（{count} 个）
        </button>
      </div>

      {/* 一行一个域名，能直接粘进注册商的批量注册框 */}
      <textarea
        ref={taRef}
        readOnly
        value={text || "（这一档下没有域名）"}
        rows={Math.min(Math.max(count, 2), 8)}
        onFocus={(e) => e.currentTarget.select()}
        className="t-caption2 w-full rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 font-mono text-[var(--ink-secondary)] outline-none"
      />
    </div>
  );
}

// ── 回程：粘贴结果、预览、确认 ────────────────────────────────

export function BulkFulfillPanel({ activityId }: { activityId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [text, setText] = useState("");
  const [plan, setPlan] = useState<BulkPlan | null>(null);
  // 预览针对的是哪段文本 —— 文本改了预览就作废，不能拿旧预览背书新内容
  const [previewedText, setPreviewedText] = useState<string | null>(null);
  const [done, setDone] = useState<BulkCommitResult | null>(null);

  const stale = plan !== null && text !== previewedText;
  const writable = plan ? plan.fulfill.length + plan.fail.length : 0;

  const preview = () => {
    startTransition(async () => {
      const result = await previewBulkFulfill({ activityId, text });
      if (!result.ok || !result.plan) {
        toast.show({ message: result.error ?? "预览失败", kind: "error" });
        return;
      }
      setPlan(result.plan);
      setPreviewedText(text);
      setDone(null);
    });
  };

  const commit = () => {
    startTransition(async () => {
      const result = await commitBulkFulfill({ activityId, text });
      if (!result.ok) {
        toast.show({ message: result.error ?? "提交失败", kind: "error" });
        return;
      }
      setDone(result);
      setPlan(null);
      setPreviewedText(null);
      setText("");
      toast.show({
        message: `已写入：${result.fulfilled} 成功、${result.failed} 失败${
          result.skipped > 0 ? `，跳过 ${result.skipped} 条已处理的` : ""
        }`,
        kind: "success",
      });
      router.refresh();
    });
  };

  return (
    <div className="space-y-2">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        placeholder={"从注册商粘贴结果，一行一条：\nfoo.icu 成功\nbar.icu,失败,已被抢注\n只写域名默认成功"}
        className="t-caption2 w-full rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 font-mono outline-none placeholder:text-[var(--ink-quaternary)]"
      />

      <div className="flex gap-2">
        <button
          type="button"
          disabled={pending || !text.trim()}
          onClick={preview}
          className="t-subhead flex-1 rounded-[var(--radius-control)] bg-[var(--fill)] px-4 py-2 font-medium text-[var(--ink)] disabled:opacity-40"
        >
          预览
        </button>
        {/* 必须先预览：没看过「将发生什么」就写库，等于把确认步骤做成摆设 */}
        <button
          type="button"
          disabled={pending || !plan || stale || writable === 0}
          onClick={commit}
          className="t-subhead flex-1 rounded-[var(--radius-control)] bg-[var(--accent)] px-4 py-2 font-medium text-white disabled:opacity-40"
        >
          确认写入{plan && !stale ? `（${writable} 条）` : ""}
        </button>
      </div>

      {stale && (
        <p className="t-caption2 text-[var(--warning)]">内容改过了 —— 重新预览一遍再提交</p>
      )}

      {plan && !stale && <PlanView plan={plan} />}

      {done && done.errors.length > 0 && (
        <ProblemList
          tone="danger"
          title={`${done.errors.length} 条写入时失败`}
          items={done.errors.map((e) => `${e.domain}：${e.error}`)}
        />
      )}
    </div>
  );
}

function PlanView({ plan }: { plan: BulkPlan }) {
  return (
    <div className="space-y-1.5 rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2">
      <p className="t-caption text-[var(--ink-secondary)]">
        将标记 <strong>{plan.fulfill.length}</strong> 个成功、
        <strong>{plan.fail.length}</strong> 个失败
        {plan.already.length > 0 && ` · ${plan.already.length} 条已处理过（跳过，不重复通知）`}
        {plan.duplicates.length > 0 && ` · ${plan.duplicates.length} 个重复域名已合并`}
      </p>

      {/*
       * 「系统里没有这个申请」必须摆出来而不是吞掉 ——
       * 出现它多半是粘错了活动或粘错了列表，
       * 吞掉会让管理员以为整批都处理完了。
       */}
      {plan.unknown.length > 0 && (
        <ProblemList
          tone="danger"
          title={`${plan.unknown.length} 个域名在系统里没有对应申请 —— 是不是粘错了列表？这些不会被写入`}
          items={plan.unknown}
        />
      )}

      {plan.conflicts.length > 0 && (
        <ProblemList
          tone="warning"
          title={`${plan.conflicts.length} 条对不上当前状态，不会被写入`}
          items={plan.conflicts.map((c) => `${c.domain}：${c.reason}`)}
        />
      )}

      {plan.problems.length > 0 && (
        <ProblemList
          tone="warning"
          title={`${plan.problems.length} 行没解析出来`}
          items={plan.problems.map((p) => `第 ${p.line} 行「${p.raw}」：${p.reason}`)}
        />
      )}
    </div>
  );
}

function ProblemList({
  tone,
  title,
  items,
}: {
  tone: "danger" | "warning";
  title: string;
  items: string[];
}) {
  return (
    <div
      className="t-caption2 rounded-[var(--radius-control)] px-3 py-2"
      style={{
        background: `color-mix(in srgb, var(--${tone}) 10%, transparent)`,
        color: `var(--${tone})`,
      }}
    >
      <p className="font-medium">{title}</p>
      <ul className="mt-0.5 space-y-0.5">
        {items.map((item, i) => (
          <li key={i} className="font-mono">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}
