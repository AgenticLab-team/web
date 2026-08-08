"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { useToast } from "@/components/ui/Toast";
import { createInvite, revokeInvite, settleInvites } from "@/lib/invites/actions";
import { MAX_EXPIRY_DAYS, MAX_USES_LIMIT } from "@/lib/invites/rules";
import type { InviteRow } from "@/lib/invites/queries";

/**
 * 邀请码管理。
 *
 * 生成之后**把码做成可点复制**：这些码会被人复制到微信里发出去，
 * 让人手动选中八个字符是没必要的摩擦。
 *
 * 撤销时明说「已经进来的人不受影响」——
 * 不说的话，管理员会以为撤销能把人踢出去。
 */
export function InviteManager({ invites }: { invites: InviteRow[] }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  const [maxUses, setMaxUses] = useState("5");
  const [expiresInDays, setExpiresInDays] = useState("7");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // Safari 在非安全上下文会拒绝 clipboard API
      const area = document.createElement("textarea");
      area.value = code;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setCopied(code);
    setTimeout(() => setCopied(null), 1600);
  };

  const run = (fn: () => Promise<{ ok: boolean; error?: string; note?: string }>) => {
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        toast.show({ message: result.error ?? "操作失败", kind: "error" });
        return;
      }
      toast.show({ message: result.note ?? "已完成", kind: "success" });
      setReason("");
      router.refresh();
    });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2.5 rounded-[var(--radius-card)] bg-[var(--surface)] p-4 hairline">
        <p className="t-caption2 font-medium uppercase tracking-[0.06em] text-[var(--ink-quaternary)]">
          生成新码
        </p>

        <div className="grid gap-2 sm:grid-cols-2">
          <label className="block">
            <span className="t-caption2 mb-1 block text-[var(--ink-quaternary)]">
              可用次数（留空不限，最多 {MAX_USES_LIMIT}）
            </span>
            <input
              type="number"
              min={1}
              max={MAX_USES_LIMIT}
              value={maxUses}
              onChange={(e) => setMaxUses(e.target.value)}
              className={`tabular ${inputClass}`}
            />
          </label>
          <label className="block">
            <span className="t-caption2 mb-1 block text-[var(--ink-quaternary)]">
              有效期天数（留空不限，最多 {MAX_EXPIRY_DAYS}）
            </span>
            <input
              type="number"
              min={1}
              max={MAX_EXPIRY_DAYS}
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(e.target.value)}
              className={`tabular ${inputClass}`}
            />
          </label>
        </div>

        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="备注（给谁的、什么场合用）"
          className={inputClass}
        />

        <button
          type="button"
          disabled={pending}
          onClick={() =>
            run(async () => {
              const result = await createInvite({
                maxUses: maxUses.trim() === "" ? null : Number(maxUses),
                expiresInDays: expiresInDays.trim() === "" ? null : Number(expiresInDays),
                note,
              });
              if (result.ok) setNote("");
              return { ...result, note: result.code ? `已生成 ${result.code}` : result.note };
            })
          }
          className="t-subhead w-full rounded-[var(--radius-control)] bg-[var(--accent)] px-4 py-2 font-medium text-[var(--accent-ink)] disabled:opacity-40"
        >
          生成邀请码
        </button>

        <p className="t-caption leading-relaxed text-[var(--ink-tertiary)]">
          码里不含 0/O、1/I/L 这类形近字符 —— 它们会被人念出来、抄下来、
          在微信里转发，少一个歧义字符就少一批「码是对的但输错了」的求助。
        </p>
      </div>

      {invites.length > 0 && (
        <>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="撤销理由（撤销前先填这里）"
            className={inputClass}
          />

          <div className="inset-group">
            {invites.map((invite) => (
              <div key={invite.id} className="inset-row flex items-center gap-2 px-4 py-2.5">
                <button
                  type="button"
                  onClick={() => copy(invite.code)}
                  className="tabular t-body shrink-0 font-mono transition active:opacity-60"
                  title="点一下复制"
                >
                  {invite.code}
                </button>

                {copied === invite.code && (
                  <span className="t-caption2 shrink-0 text-[var(--success)]">已复制</span>
                )}

                <span className="t-caption min-w-0 flex-1 truncate text-[var(--ink-tertiary)]">
                  {invite.note ?? "无备注"} · {invite.statusLabel}
                  {invite.usedCount > 0 && ` · 已用 ${invite.usedCount}`}
                  {invite.rewarded > 0 && ` · 已奖励 ${invite.rewarded}`}
                  {/* 回滚数高说明这个码在被滥用 */}
                  {invite.reverted > 0 && (
                    <span style={{ color: "var(--danger)" }}> · 回滚 {invite.reverted}</span>
                  )}
                </span>

                {invite.revokedAt === null && (
                  <button
                    type="button"
                    disabled={pending || !reason.trim()}
                    title={reason.trim() ? "撤销" : "先在上面填个理由"}
                    onClick={() => run(() => revokeInvite({ id: invite.id, reason }))}
                    className="t-caption shrink-0 rounded-[var(--radius-pill)] px-2.5 py-1 disabled:opacity-30"
                    style={{ color: "var(--danger)" }}
                  >
                    撤销
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      <button
        type="button"
        disabled={pending}
        onClick={() => run(settleInvites)}
        className="t-subhead w-full rounded-[var(--radius-control)] bg-[var(--fill)] px-4 py-2 font-medium disabled:opacity-40"
      >
        补跑一次奖励结算
      </button>
      <p className="t-caption px-1 leading-relaxed text-[var(--ink-tertiary)]">
        结算平时挂在打卡流程上，这里是兜底入口 ——
        流程可能因为改代码或异常漏掉，有个能重跑的地方比祈祷流程永不出错可靠。
      </p>
    </div>
  );
}

const inputClass =
  "t-subhead w-full rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 outline-none placeholder:text-[var(--ink-quaternary)]";
