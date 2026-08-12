"use client";

import { Lock, LockOpen } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  AdminButton,
  AdminNote,
  AdminPanel,
  AdminPanelLabel,
  AdminRow,
  adminFieldClass,
} from "@/components/admin/ui";
import { useToast } from "@/components/ui/Toast";
import { cleanupTags, mergeTags, renameTag, setTagLocked } from "@/lib/admin/board-actions";

/**
 * 标签管理。
 *
 * 标签墙一年后会变成同义词垃圾场：RAG / rag / Rag / 检索增强 各自一个。
 * 归一化只能挡住大小写和分隔符，**语义上的同义词只能人工合并**，
 * 所以合并要好用 —— 不好用就没人会去做。
 *
 * 合并**不可撤销**，所以：
 *   - 先选源再选目标，方向写在按钮上（「把 A 并入 B」），不靠位置记忆
 *   - 直接显示两边各有多少帖子，合并后是多少
 */

export interface TagItem {
  id: string;
  name: string;
  slug: string;
  locked: boolean;
  liveCount: number;
  cachedCount: number;
}

export function TagManager({ tags, orphanCount }: { tags: TagItem[]; orphanCount: number }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [reason, setReason] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [newName, setNewName] = useState("");

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, success: string) => {
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        toast.show({ message: result.error ?? "操作失败", kind: "error" });
        return;
      }
      toast.show({ message: success, kind: "success" });
      setFromId("");
      setToId("");
      setReason("");
      setRenaming(null);
      router.refresh();
    });
  };

  const from = tags.find((t) => t.id === fromId);
  const to = tags.find((t) => t.id === toId);

  if (tags.length === 0) {
    return <AdminNote>还没有任何标签。发帖时打上就会出现在这里。</AdminNote>;
  }

  return (
    <div className="space-y-4">
      <div className="inset-group">
        {tags.map((tag) => (
          <AdminRow key={tag.id}>
            <span className="t-body min-w-0 flex-1 truncate">
              {tag.name}
              <span className="t-caption2 ml-1.5 font-mono text-[var(--ink-quaternary)]">
                {tag.slug}
              </span>
            </span>

            <span className="tabular t-caption shrink-0 text-[var(--ink-tertiary)]">
              {tag.liveCount}
              {tag.cachedCount !== tag.liveCount && (
                // 冗余列漂移过一次（版块计数显示 0），这里把两边都摆出来
                <span className="text-[var(--warning)]"> ≠{tag.cachedCount}</span>
              )}
            </span>

            <button
              type="button"
              disabled={pending}
              onClick={() =>
                run(
                  () => setTagLocked({ id: tag.id, locked: !tag.locked }),
                  tag.locked ? "已解锁" : "已锁定，不会被清理或合并掉",
                )
              }
              aria-label={tag.locked ? `解锁「${tag.name}」` : `锁定「${tag.name}」`}
              title={tag.locked ? "解锁" : "锁定：不会被清理或合并掉"}
              // tap-target：视觉还是 28px，可点范围撑到 44px
              className="tap-target shrink-0 rounded-[var(--radius-control)] p-1.5 text-[var(--ink-tertiary)] transition-colors hover:bg-[var(--fill)]"
            >
              {tag.locked ? (
                <Lock className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              ) : (
                <LockOpen className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              )}
            </button>

            <AdminButton
              tone="neutral"
              size="sm"
              aria-expanded={renaming === tag.id}
              onClick={() => {
                setRenaming(renaming === tag.id ? null : tag.id);
                setNewName(tag.name);
              }}
            >
              改名
            </AdminButton>
          </AdminRow>
        ))}
      </div>

      {renaming && (
        <AdminPanel className="animate-rise space-y-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="新名字"
            className={adminFieldClass}
          />
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="理由（必填）"
            className={adminFieldClass}
          />
          <AdminButton
            tone="primary"
            block
            disabled={pending || !newName.trim() || !reason.trim()}
            onClick={() => run(() => renameTag({ id: renaming, name: newName, reason }), "已改名")}
          >
            保存
          </AdminButton>
          <AdminNote className="px-0">
            改名会同时改归一化后的 slug。如果新名字归一化后撞上了已有标签，
            这里会让你改用合并 —— 那才是正确的做法。
          </AdminNote>
        </AdminPanel>
      )}

      <AdminPanel className="space-y-2">
        <AdminPanelLabel>合并同义标签</AdminPanelLabel>
        <div className="grid gap-2 sm:grid-cols-2">
          <select
            value={fromId}
            onChange={(e) => setFromId(e.target.value)}
            aria-label="把哪个标签合并掉"
            className={adminFieldClass}
          >
            <option value="">把哪个标签…</option>
            {tags
              .filter((t) => !t.locked)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}（{t.liveCount} 篇）
                </option>
              ))}
          </select>
          <select
            value={toId}
            onChange={(e) => setToId(e.target.value)}
            aria-label="并入哪个标签"
            className={adminFieldClass}
          >
            <option value="">…并入哪个</option>
            {tags
              .filter((t) => t.id !== fromId)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}（{t.liveCount} 篇）
                </option>
              ))}
          </select>
        </div>

        {from && to && (
          <p className="t-caption text-[var(--ink-secondary)]">
            「{from.name}」会消失，它的 {from.liveCount} 篇帖子改挂到「{to.name}」下。
            两边都有的帖子只保留一条关联。<strong>此操作不可撤销。</strong>
          </p>
        )}

        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="理由（必填）"
          className={adminFieldClass}
        />

        {/* 合并不可撤销 —— 归 danger，和这个后台里其它「回不去了」的动作同一档。
            原来它是 accent 主色，看起来和「保存」一样安全 */}
        <AdminButton
          tone={from && to ? "danger" : "neutral"}
          block
          disabled={pending || !from || !to || !reason.trim()}
          onClick={() => run(() => mergeTags({ fromId, toId, reason }), "已合并")}
        >
          {from && to ? `把「${from.name}」并入「${to.name}」` : "先选两个标签"}
        </AdminButton>
      </AdminPanel>

      {orphanCount > 0 && (
        <AdminPanel className="space-y-2">
          <p className="t-subhead">有 {orphanCount} 个标签没有任何帖子在用</p>
          <p className="t-caption leading-relaxed text-[var(--ink-tertiary)]">
            清理它们是安全的，标签本身不承载内容。<strong>锁定的不会被清掉</strong> ——
            锁定往往正是为了预留一个还没开始用的官方标签。
          </p>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="理由（必填）"
            className={adminFieldClass}
          />
          <AdminButton
            tone="neutral"
            block
            disabled={pending || !reason.trim()}
            onClick={() => run(() => cleanupTags({ reason }), `已清理 ${orphanCount} 个标签`)}
          >
            清理这 {orphanCount} 个无用标签
          </AdminButton>
        </AdminPanel>
      )}
    </div>
  );
}
