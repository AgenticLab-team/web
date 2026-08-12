"use client";

import { Check, Fingerprint, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { useToast } from "@/components/ui/Toast";

import { registerSuccessFeedback, revokeFeedback } from "./feedback";
import { usePasskeyRegister, usePasskeySupport } from "./usePasskey";

export interface PasskeyItem {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  backedUp: boolean;
}

/**
 * Passkey 管理。
 *
 * 移除凭证不弹确认框 —— 直接执行并给撤销机会（见 HIG 那一条）。
 * 但**移除最后一把钥匙**是个例外：那之后就只能回微信取验证码了，
 * 这个后果值得让用户知道。
 */
export function PasskeySetup({ items }: { items: PasskeyItem[] }) {
  const router = useRouter();
  const toast = useToast();
  const support = usePasskeySupport();
  const [justAdded, setJustAdded] = useState(false);
  const { busy, error, register } = usePasskeyRegister(() => {
    setJustAdded(true);
    // 按钮变绿 + Toast 双通道：按钮状态盯着屏幕才看得到，
    // Toast 还会被读屏软件播报（Provider 里有 aria-live）
    toast.show(registerSuccessFeedback());
    router.refresh();
    setTimeout(() => setJustAdded(false), 2600);
  });
  const [removing, setRemoving] = useState<string | null>(null);

  const remove = async (id: string, name: string) => {
    setRemoving(id);
    try {
      const res = await fetch("/api/auth/passkey/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const body = await res.json().catch(() => ({}));
      // 失败必须让用户知道 —— 静默失败会让人以为钥匙删掉了，其实还能登录
      toast.show(revokeFeedback(name, { ok: res.ok, serverError: body.error }));
      if (res.ok) router.refresh();
    } catch {
      toast.show(revokeFeedback(name, { ok: false, serverError: "网络异常，请重试" }));
    } finally {
      // 以前网络一断这里就永远停在 removing 状态，按钮再也点不了
      setRemoving(null);
    }
  };

  if (support === "unsupported") {
    return (
      <div className="inset-group px-4 py-5 text-center">
        <p className="t-subhead text-[var(--ink-secondary)]">这个浏览器不支持 Passkey</p>
        <p className="t-caption mt-1 text-[var(--ink-tertiary)]">
          换用 Safari、Chrome 或 Edge 的较新版本即可
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {items.length > 0 && (
        <div className="inset-group">
          {items.map((item) => (
            <div key={item.id} className="inset-row flex items-center gap-3 px-4 py-3">
              <Fingerprint
                className="h-[1.125rem] w-[1.125rem] shrink-0 text-[var(--accent)]"
                strokeWidth={1.9}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <p className="t-body truncate leading-tight">{item.name}</p>
                <p className="t-caption text-[var(--ink-tertiary)]">
                  {item.lastUsedAt
                    ? `上次使用 ${formatWhen(item.lastUsedAt)}`
                    : `添加于 ${formatWhen(item.createdAt)} · 还没用过`}
                  {item.backedUp && " · 已同步到钥匙串"}
                </p>
              </div>
              <button
                type="button"
                aria-label={`移除 ${item.name}`}
                disabled={removing === item.id}
                onClick={() => void remove(item.id, item.name)}
                className="tap-target shrink-0 rounded-[var(--radius-chip)] p-2 text-[var(--ink-tertiary)] transition-colors hover:bg-[var(--fill)] hover:text-[var(--danger)] disabled:opacity-40"
              >
                <Trash2 className="h-4 w-4" strokeWidth={1.9} aria-hidden />
              </button>
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        disabled={busy || support === "unknown"}
        onClick={() => void register()}
        className={`flex w-full items-center justify-center gap-2 rounded-[var(--radius-control)] px-6 py-3 transition active:scale-[0.98] disabled:opacity-50 ${
          justAdded
            ? "bg-[var(--success)] text-white"
            : items.length
              ? "bg-[var(--fill)] text-[var(--ink)]"
              : "bg-[var(--accent)] text-[var(--accent-ink)]"
        }`}
      >
        {justAdded ? (
          <>
            <Check className="h-[1.125rem] w-[1.125rem]" strokeWidth={2.4} aria-hidden />
            <span className="t-body font-medium">已添加</span>
          </>
        ) : (
          <>
            <Fingerprint className="h-[1.125rem] w-[1.125rem]" strokeWidth={2} aria-hidden />
            <span className="t-body font-medium">
              {busy ? "等待验证…" : items.length ? "添加另一台设备" : "设置 Passkey"}
            </span>
          </>
        )}
      </button>

      {error && (
        <p className="t-footnote px-1 text-center text-[var(--danger)]" role="alert">
          {error}
        </p>
      )}

      {items.length === 0 && (
        <p className="t-caption px-1 leading-relaxed text-[var(--ink-tertiary)]">
          用指纹、面容或设备密码登录，不必再回微信取验证码。
          凭证只存在这台设备上，我们拿不到也复制不走。
        </p>
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
