"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { AdminButton, AdminChip, adminFieldClass } from "@/components/admin/ui";
import { useToast } from "@/components/ui/Toast";
import { grantRole, revokeRole } from "@/lib/admin/user-actions";
import type { BoardModerator } from "@/lib/admin/moderators";

/**
 * 版主任免。
 *
 * 默认**带到期时间**（三个月），而不是默认永久。
 * 「临时帮忙看两周」是最常见的情形，而不设到期的话，
 * 一年后没人记得当初为什么给了这个人权限，也没人好意思去收 ——
 * 到期自动回收把这件尴尬事变成了默认行为。
 *
 * 想给永久的仍然可以选「不设到期」，只是要多点一下。
 */

const PRESETS = [
  { days: 14, label: "两周" },
  { days: 90, label: "三个月" },
  { days: 365, label: "一年" },
  { days: 0, label: "不设到期" },
];

export function BoardModerators({
  boardId,
  boardName,
  moderators,
  candidates,
}: {
  boardId: string;
  boardName: string;
  moderators: BoardModerator[];
  candidates: { id: string; name: string }[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);

  const [userId, setUserId] = useState(candidates[0]?.id ?? "");
  const [days, setDays] = useState(90);
  const [reason, setReason] = useState("");

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, success: string) => {
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        toast.show({ message: result.error ?? "操作失败", kind: "error" });
        return;
      }
      toast.show({ message: success, kind: "success" });
      setReason("");
      router.refresh();
    });
  };

  return (
    <div className="mt-3 border-t border-[var(--separator)] pt-3">
      <div className="flex items-center gap-2">
        <span className="t-group-label">
          版主 {moderators.filter((m) => !m.expired).length}
        </span>
        <AdminButton
          tone="neutral"
          size="sm"
          className="ml-auto"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? "收起" : "任免"}
        </AdminButton>
      </div>

      {moderators.length > 0 && (
        <ul className="mt-2 space-y-1">
          {moderators.map((m) => (
            <li key={m.userRoleId} className="flex items-center gap-2">
              <span className={`t-caption min-w-0 flex-1 truncate ${m.expired ? "opacity-45" : ""}`}>
                {m.name}
                {m.expiresAt !== null && (
                  <span
                    className="t-caption2 ml-1.5"
                    style={{
                      color: m.expired
                        ? "var(--ink-quaternary)"
                        : m.expiringSoon
                          ? "var(--warning)"
                          : "var(--ink-quaternary)",
                    }}
                  >
                    {m.expired
                      ? "已到期"
                      : `${new Date(m.expiresAt).toLocaleDateString("zh-CN")} 到期`}
                  </span>
                )}
              </span>
              {/* 解除版主是收权限 —— dangerSoft，和用户页的「移除身份组」同一档 */}
              {open && (
                <AdminButton
                  tone="dangerSoft"
                  size="sm"
                  disabled={pending || !reason.trim()}
                  title={reason.trim() ? "解除他的版主身份" : "先在下面填个理由"}
                  onClick={() =>
                    run(() => revokeRole({ userRoleId: m.userRoleId, reason }), "已解除")
                  }
                >
                  解除
                </AdminButton>
              )}
            </li>
          ))}
        </ul>
      )}

      {open && (
        <div className="animate-rise mt-2.5 space-y-2">
          {candidates.length === 0 ? (
            <p className="t-caption text-[var(--ink-tertiary)]">
              暂时没有可任命的人 —— 候选人只列登录过网站的成员，
              从没打开过网站的人当版主等于没有版主。
            </p>
          ) : (
            <>
              <select
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                className={adminFieldClass}
              >
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>

              <div className="flex flex-wrap gap-1.5">
                {PRESETS.map((p) => (
                  <AdminChip key={p.days} active={days === p.days} onClick={() => setDays(p.days)}>
                    {p.label}
                  </AdminChip>
                ))}
              </div>

              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="理由（必填）"
                className={adminFieldClass}
              />

              <AdminButton
                tone="primary"
                block
                disabled={pending || !userId || !reason.trim()}
                onClick={() =>
                  run(
                    () =>
                      grantRole({
                        userId,
                        roleKey: "moderator",
                        reason,
                        scopeType: "board",
                        scopeId: boardId,
                        expiresAt: days > 0 ? Date.now() + days * 86_400_000 : undefined,
                      }),
                    `已任命为「${boardName}」版主`,
                  )
                }
              >
                任命为「{boardName}」版主
              </AdminButton>

              <p className="t-caption2 text-[var(--ink-quaternary)]">
                权限只在「{boardName}」这一个版块内生效。
                默认带到期时间 —— 到期自动回收，省得日后没人好意思去收。
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
