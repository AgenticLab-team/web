"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import { relativeTime } from "@/components/forum/PostList";
import { useToast } from "@/components/ui/Toast";
import { bulkModeratePosts } from "@/lib/admin/post-actions";
import type { AdminPostRow } from "@/lib/admin/posts";
import {
  ACTION_LABELS,
  BULK_LIMIT,
  distinctAuthors,
  isDestructive,
  type BulkAction,
} from "@/lib/moderation/bulk-rules";

/**
 * 帖子批量管理。
 *
 * 批量操作是后台里最容易造成不可逆损失的功能。所以：
 *
 *   - 操作条上写的是「12 条 · 影响 9 位作者」，不只是「12 条」。
 *     后者是数据，前者才让人意识到这是在动别人的东西。
 *   - 破坏性动作要多一步确认，并把前几个标题列出来 ——
 *     看见具体是哪几篇，比看见数字更能拦住手滑。
 *   - **全选只选当前页**，不提供「选中全部搜索结果」。
 *     那个功能存在的唯一价值就是一次删掉几百条，
 *     而那正是最不该一键完成的事。
 */

const STATUS_LABELS: Record<string, string> = {
  published: "已发布",
  draft: "草稿",
  locked: "已锁定",
  hidden: "已隐藏",
  deleted: "已删除",
};

const STATUS_COLORS: Record<string, string> = {
  hidden: "var(--warning)",
  deleted: "var(--danger)",
  locked: "var(--ink-tertiary)",
};

export function PostBulkTable({ rows }: { rows: AdminPostRow[] }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [action, setAction] = useState<BulkAction>("hide");
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);

  const chosen = useMemo(() => rows.filter((r) => selected.has(r.id)), [rows, selected]);
  const authors = distinctAuthors(chosen);
  const overLimit = selected.size > BULK_LIMIT;

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setConfirming(false);
  };

  const toggleAll = () => {
    setSelected((prev) => (prev.size === rows.length ? new Set() : new Set(rows.map((r) => r.id))));
    setConfirming(false);
  };

  const run = () => {
    startTransition(async () => {
      const result = await bulkModeratePosts({
        ids: [...selected],
        action,
        reason,
      });

      if (!result.ok && !result.report) {
        toast.show({ message: result.error ?? "操作失败", kind: "error" });
        return;
      }

      // 部分失败也要说清楚，不能只报成功数
      toast.show({
        message: result.report?.message ?? "已处理",
        kind: result.report && result.report.failed.length > 0 ? "error" : "success",
      });

      setSelected(new Set());
      setReason("");
      setConfirming(false);
      router.refresh();
    });
  };

  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 px-1">
        <input
          type="checkbox"
          checked={rows.length > 0 && selected.size === rows.length}
          onChange={toggleAll}
          className="h-4 w-4"
        />
        <span className="t-caption text-[var(--ink-tertiary)]">
          全选本页（{rows.length} 条）
        </span>
      </label>

      <div className="inset-group">
        {rows.map((row) => (
          <div key={row.id} className="inset-row flex items-start gap-3 px-4 py-3">
            <input
              type="checkbox"
              checked={selected.has(row.id)}
              onChange={() => toggle(row.id)}
              className="mt-1 h-4 w-4 shrink-0"
              aria-label={`选择「${row.title}」`}
            />

            <div className="min-w-0 flex-1">
              <p className="t-body flex flex-wrap items-center gap-1.5">
                <Link href={`/forum/p/${row.id}`} className="truncate">
                  {row.title}
                </Link>
                {STATUS_COLORS[row.status] && (
                  <span
                    className="t-caption2 shrink-0 rounded-[var(--radius-pill)] px-1.5 py-0.5 font-medium"
                    style={{
                      background: `color-mix(in srgb, ${STATUS_COLORS[row.status]} 15%, transparent)`,
                      color: STATUS_COLORS[row.status],
                    }}
                  >
                    {STATUS_LABELS[row.status] ?? row.status}
                  </span>
                )}
                {row.fromGroupChat && (
                  <span className="t-caption2 shrink-0 text-[var(--ink-quaternary)]">群聊转帖</span>
                )}
                {row.featured && (
                  <span className="t-caption2 shrink-0 text-[var(--accent)]">精</span>
                )}
              </p>

              <p className="t-caption mt-0.5 truncate text-[var(--ink-tertiary)]">
                <Link href={`/admin/users/${row.authorId}`}>{row.authorName}</Link> ·{" "}
                {row.boardName} · {row.visibilityLabel} · {row.replyCount} 回复 ·{" "}
                {relativeTime(row.createdAt)}
              </p>

              {row.deleteReason && (
                <p className="t-caption2 mt-0.5 truncate text-[var(--ink-quaternary)]">
                  删除理由：{row.deleteReason}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* 操作条只在选了东西之后出现，避免它一直占着屏幕底部 */}
      {selected.size > 0 && (
        <div className="animate-rise sticky bottom-[calc(var(--tabbar-height)+1rem)] z-10 space-y-2.5 rounded-[var(--radius-card)] bg-[var(--surface)] p-3.5 shadow-[0_4px_20px_rgb(0_0_0/0.12)] hairline lg:bottom-4">
          <p className="t-subhead">
            已选 <span className="tabular font-medium">{selected.size}</span> 条 ·{" "}
            {/* 说「影响 9 位作者」而不只是「9 条」—— 后者是数据，前者是人 */}
            影响 <span className="tabular font-medium">{authors}</span> 位作者
          </p>

          {overLimit && (
            <p className="t-caption" style={{ color: "var(--danger)" }}>
              一次最多处理 {BULK_LIMIT} 条，请分批做 —— 分批的过程本身就是几次「你确定吗」。
            </p>
          )}

          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(ACTION_LABELS) as BulkAction[]).map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => {
                  setAction(a);
                  setConfirming(false);
                }}
                className={`t-footnote rounded-[var(--radius-pill)] px-3 py-1.5 transition-colors ${
                  action === a
                    ? "bg-[var(--ink)] font-medium text-[var(--canvas)]"
                    : "bg-[var(--fill)] text-[var(--ink-secondary)]"
                }`}
              >
                {ACTION_LABELS[a]}
              </button>
            ))}
          </div>

          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={
              isDestructive(action)
                ? "理由（必填，至少四个字，作者会看到）"
                : "理由（必填，会记入审计日志）"
            }
            className="t-subhead w-full rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 outline-none placeholder:text-[var(--ink-quaternary)]"
          />

          {/* 破坏性操作多一步：把具体是哪几篇列出来 */}
          {confirming && isDestructive(action) ? (
            <div className="space-y-2 rounded-[var(--radius-control)] px-3 py-2.5" style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)" }}>
              <p className="t-subhead font-medium" style={{ color: "var(--danger)" }}>
                确认{ACTION_LABELS[action]}这 {selected.size} 条？
              </p>
              <ul className="space-y-0.5">
                {chosen.slice(0, 5).map((r) => (
                  <li key={r.id} className="t-caption truncate text-[var(--ink-secondary)]">
                    · {r.title}
                  </li>
                ))}
                {chosen.length > 5 && (
                  <li className="t-caption text-[var(--ink-tertiary)]">
                    …还有 {chosen.length - 5} 条
                  </li>
                )}
              </ul>
              <p className="t-caption2 text-[var(--ink-tertiary)]">
                每位作者都会收到通知，每一条都会留下独立的处罚记录。
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={pending}
                  onClick={run}
                  className="t-subhead flex-1 rounded-[var(--radius-control)] px-4 py-2 font-medium disabled:opacity-40"
                  style={{ background: "var(--danger)", color: "var(--canvas)" }}
                >
                  确认{ACTION_LABELS[action]}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="t-subhead rounded-[var(--radius-control)] bg-[var(--fill)] px-4 py-2"
                >
                  再想想
                </button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <button
                type="button"
                disabled={pending || !reason.trim() || overLimit}
                onClick={() => (isDestructive(action) ? setConfirming(true) : run())}
                className="t-subhead flex-1 rounded-[var(--radius-control)] bg-[var(--accent)] px-4 py-2 font-medium text-[var(--accent-ink)] disabled:opacity-40"
              >
                {ACTION_LABELS[action]}选中的 {selected.size} 条
              </button>
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="t-subhead rounded-[var(--radius-control)] bg-[var(--fill)] px-4 py-2 text-[var(--ink-secondary)]"
              >
                取消选择
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
