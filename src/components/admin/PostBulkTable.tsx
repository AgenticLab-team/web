"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import {
  AdminActions,
  AdminButton,
  AdminChip,
  AdminRow,
  AdminStickyBar,
  AdminTag,
  adminFieldClass,
} from "@/components/admin/ui";
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
      {/* 复选框做到 20px 并给行留出 44px 的落点 —— 原来是 16px 的裸方框，
          手机上要点中它基本靠运气，而点歪的结果是打开帖子而不是选中 */}
      <label className="flex min-h-11 items-center gap-2.5 px-1">
        <input
          type="checkbox"
          checked={rows.length > 0 && selected.size === rows.length}
          onChange={toggleAll}
          className="h-5 w-5 accent-[var(--accent)]"
        />
        <span className="t-caption text-[var(--ink-tertiary)]">
          全选本页（{rows.length} 条）
        </span>
      </label>

      <div className="inset-group">
        {rows.map((row) => (
          <AdminRow key={row.id} align="start">
            <input
              type="checkbox"
              checked={selected.has(row.id)}
              onChange={() => toggle(row.id)}
              className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--accent)]"
              aria-label={`选择「${row.title}」`}
            />

            <div className="min-w-0 flex-1">
              <p className="t-body flex flex-wrap items-center gap-1.5">
                <Link href={`/forum/p/${row.id}`} className="truncate">
                  {row.title}
                </Link>
                {STATUS_COLORS[row.status] && (
                  <AdminTag color={STATUS_COLORS[row.status]}>
                    {STATUS_LABELS[row.status] ?? row.status}
                  </AdminTag>
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
          </AdminRow>
        ))}
      </div>

      {/* 操作条只在选了东西之后出现，避免它一直占着屏幕底部。
          偏移和权限矩阵那条共用一个组件 —— 那边曾经写成 bottom-0，
          手机上保存键整个压在 Tab Bar 底下点不到 */}
      {selected.size > 0 && (
        <AdminStickyBar>
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
              <AdminChip
                key={a}
                active={action === a}
                onClick={() => {
                  setAction(a);
                  setConfirming(false);
                }}
              >
                {ACTION_LABELS[a]}
              </AdminChip>
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
            className={adminFieldClass}
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
              <AdminActions>
                <AdminButton tone="danger" className="flex-1" disabled={pending} onClick={run}>
                  确认{ACTION_LABELS[action]}
                </AdminButton>
                <AdminButton tone="quiet" onClick={() => setConfirming(false)}>
                  再想想
                </AdminButton>
              </AdminActions>
            </div>
          ) : (
            <AdminActions>
              <AdminButton
                tone="primary"
                className="flex-1"
                disabled={pending || !reason.trim() || overLimit}
                onClick={() => (isDestructive(action) ? setConfirming(true) : run())}
              >
                {ACTION_LABELS[action]}选中的 {selected.size} 条
              </AdminButton>
              <AdminButton tone="quiet" onClick={() => setSelected(new Set())}>
                取消选择
              </AdminButton>
            </AdminActions>
          )}
        </AdminStickyBar>
      )}
    </div>
  );
}
