"use client";

import { Check, Lock, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { raiseVisibility, respondToConsent } from "@/lib/forum/convert";
import type { ConsentSummary } from "@/lib/forum/convert-queries";

/**
 * 群聊转帖的同意面板。
 *
 * 三种角色看到的东西不同：
 *   被引用的人 —— 表态入口
 *   管理员     —— 提升可见性（仅当全体同意）
 *   其他人     —— 只看到当前状态
 *
 * 「多数同意」在这里不成立：被拒绝的那个人的发言依然会被公开，
 * 所以必须全体同意，界面上也要把这一点说清楚。
 */
export function ConsentPanel({
  postId,
  summary,
  canModerate,
}: {
  postId: string;
  summary: ConsentSummary;
  canModerate: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [raising, setRaising] = useState(false);

  if (!summary.isConverted) return null;

  return (
    <div className="mb-5 space-y-3 rounded-[var(--radius-card)] bg-[var(--accent-soft)] p-4">
      <div className="flex items-start gap-2.5">
        <Lock className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent)]" strokeWidth={2} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="t-subhead font-medium text-[var(--accent)]">这是从群聊整理来的内容</p>
          <p className="t-caption mt-1 leading-relaxed text-[var(--ink-secondary)]">
            目前只有原群成员可见。
            {summary.total > 0 && (
              <>
                {" "}
                <span className="tabular">
                  {summary.granted}/{summary.total}
                </span>{" "}
                位原作者同意公开
                {summary.denied > 0 && (
                  <span className="text-[var(--danger)]">，{summary.denied} 位不同意</span>
                )}
              </>
            )}
          </p>
        </div>
      </div>

      {/* 我被引用了，还没表态 */}
      {summary.myStatus === "pending" && (
        <div className="space-y-2 rounded-[var(--radius-control)] bg-[var(--surface)] p-3">
          <p className="t-footnote leading-relaxed">
            你在这段群聊里的发言被引用了。
            <strong>同意后，社区里更多人（甚至未登录访客）会看到它。</strong>
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  await respondToConsent({ postId, grant: true });
                  router.refresh();
                })
              }
              className="t-footnote flex flex-1 items-center justify-center gap-1 rounded-[var(--radius-control)] bg-[var(--accent)] px-3 py-2 font-medium text-[var(--accent-ink)]"
            >
              <Check className="h-3.5 w-3.5" strokeWidth={2.4} aria-hidden />
              同意公开
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  await respondToConsent({ postId, grant: false });
                  router.refresh();
                })
              }
              className="t-footnote flex flex-1 items-center justify-center gap-1 rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2"
            >
              <X className="h-3.5 w-3.5" strokeWidth={2.4} aria-hidden />
              不同意
            </button>
          </div>
        </div>
      )}

      {summary.myStatus === "granted" && (
        <p className="t-caption text-[var(--success)]">你已同意公开这段内容</p>
      )}
      {summary.myStatus === "denied" && (
        <p className="t-caption text-[var(--ink-secondary)]">
          你不同意公开 —— 这篇帖子会一直保持只有本群成员可见
        </p>
      )}

      {/*
        * 不是版主的人：齐了之后要知道在等什么。
        *
        * 只显示「3/3 位原作者同意公开」而帖子还锁着的话，
        * 读起来像是坏了 —— 而整理的人多半会以为是自己哪一步没做完，
        * 然后去点一遍所有按钮。
        */}
      {!canModerate && summary.canRaise && (
        <p className="t-caption leading-relaxed text-[var(--ink-secondary)]">
          所有原作者都同意了 —— 接下来由版主决定提到哪个范围。
          <span className="text-[var(--ink-tertiary)]">
            {" "}
            放大别人在群里说过的话是一次治理动作，所以这一步不由整理的人自己按。
          </span>
        </p>
      )}

      {/* 管理员：全体同意后才出现提升入口 */}
      {canModerate && summary.canRaise && !raising && (
        <button
          type="button"
          onClick={() => setRaising(true)}
          className="t-footnote w-full rounded-[var(--radius-control)] bg-[var(--surface)] px-3 py-2 font-medium"
        >
          全员已同意 · 提升可见范围
        </button>
      )}

      {canModerate && summary.canRaise && raising && (
        <div className="space-y-2 rounded-[var(--radius-control)] bg-[var(--surface)] p-3">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="为什么值得公开？（会记入审计日志）"
            className="t-footnote w-full rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 outline-none"
          />
          {error && (
            <p className="t-caption text-[var(--danger)]" role="alert">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            {(["member", "public"] as const).map((level) => (
              <button
                key={level}
                type="button"
                disabled={pending || !reason.trim()}
                onClick={() =>
                  startTransition(async () => {
                    const result = await raiseVisibility({ postId, to: level, reason });
                    if (!result.ok) setError(result.error ?? "失败");
                    else {
                      setRaising(false);
                      router.refresh();
                    }
                  })
                }
                className="t-footnote flex-1 rounded-[var(--radius-control)] bg-[var(--accent)] px-3 py-2 font-medium text-[var(--accent-ink)] disabled:opacity-40"
              >
                {level === "member" ? "改为成员可见" : "改为完全公开"}
              </button>
            ))}
          </div>
        </div>
      )}

      {canModerate && !summary.canRaise && summary.total > 0 && (
        <p className="t-caption text-[var(--ink-tertiary)]">
          需要<strong>全部</strong> {summary.total} 位原作者同意才能提升可见范围 ——
          多数同意不算，被拒绝那位的发言同样会被公开。
        </p>
      )}
    </div>
  );
}
