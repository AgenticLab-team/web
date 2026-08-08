"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { DeviceSession } from "@/lib/auth/devices";

/**
 * 已登录设备列表。
 *
 * 下线单个设备直接执行 + 给撤销机会；
 * 「下线全部」是个例外 —— 它会把当前这台也踢掉，等于自己登出，
 * 这个后果必须先说清楚，不能默默执行。
 */
export function SessionList({ sessions }: { sessions: DeviceSession[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);

  const revoke = async (id: string) => {
    setBusy(id);
    await fetch("/api/auth/sessions/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    setBusy(null);
    router.refresh();
  };

  const revokeAll = async () => {
    setBusy("all");
    await fetch("/api/auth/sessions/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ all: true }),
    });
    // 当前会话也被撤销了，回登录页
    router.replace("/login");
  };

  return (
    <div className="space-y-3">
      <div className="inset-group">
        {sessions.map((session) => (
          <div key={session.id} className="inset-row flex items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="t-body truncate leading-tight">
                {session.device}
                {session.current && (
                  <span className="t-caption ml-1.5 text-[var(--accent)]">当前设备</span>
                )}
              </p>
              <p className="tabular t-caption text-[var(--ink-tertiary)]">
                {session.ip ?? "未知 IP"} · 活跃于 {formatWhen(session.lastSeenAt)}
              </p>
            </div>
            {!session.current && (
              <button
                type="button"
                disabled={busy === session.id}
                onClick={() => void revoke(session.id)}
                className="t-footnote shrink-0 rounded-[0.5rem] px-2.5 py-1.5 text-[var(--ink-tertiary)] transition-colors hover:bg-[var(--fill)] hover:text-[var(--danger)] disabled:opacity-40"
              >
                下线
              </button>
            )}
          </div>
        ))}
      </div>

      {sessions.length > 1 && (
        <div className="inset-group">
          <button
            type="button"
            disabled={busy === "all"}
            onClick={() => (confirmAll ? void revokeAll() : setConfirmAll(true))}
            onBlur={() => setConfirmAll(false)}
            className="inset-row flex w-full items-center justify-center px-4 py-3 transition-colors hover:bg-[var(--fill)]"
          >
            <span className="t-body text-[var(--danger)]">
              {confirmAll ? "确定？这会把你自己也登出" : "下线全部设备"}
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

function formatWhen(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return new Date(ts).toLocaleDateString("zh-CN");
}
