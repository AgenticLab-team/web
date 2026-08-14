"use client";

import { useState, useTransition } from "react";

import { buttonClass } from "@/components/ui/primitives";
import { SCOPES, type ScopeKey } from "@/lib/api-tokens/rules";
import { approveDeviceAction, denyDeviceAction } from "@/lib/tui/device-actions";

/**
 * 「同意 / 拒绝」那一屏的交互部分。
 *
 * ═════════════════════════════════════════
 * 两个按钮等大等重，不做视觉诱导
 * ═════════════════════════════════════════
 *
 * 把「同意」做成一个大蓝按钮、「拒绝」做成一行灰色小字，
 * 是这一类页面上最常见的做法，也是最坏的做法：
 * 它把一个**安全决定**变成了一个默认选项。
 *
 * 这一页存在的全部意义是让人停下来判断一次。
 * 一旦其中一个选项在视觉上明显更容易按，那次判断就没有发生。
 *
 * （`docs/OAUTH-PROVIDER.md` 第五节对同意页写的是同一条。）
 */

export function DeviceLinkPanel({
  code,
  asked,
  isSsh,
}: {
  code: string;
  /** 终端申请了哪些 —— 用户只能在这个集合里减，不能加 */
  asked: ScopeKey[];
  isSsh: boolean;
}) {
  /*
   * 危险级 ≥2 的默认不勾。
   *
   * 这不是「谨慎一点」，是 `lib/api-tokens/rules.ts` 里
   * `DANGEROUS_SCOPES` 那条规矩的延伸：默认勾上的东西等于没有问过。
   * 而那一条里最要紧的 `groups:send`，泄漏的后果由整个社区承担。
   */
  const [picked, setPicked] = useState<Set<ScopeKey>>(
    () => new Set(asked.filter((k) => (SCOPES.find((s) => s.key === k)?.danger ?? 0) < 2)),
  );
  const [pending, start] = useTransition();
  const [done, setDone] = useState<"approved" | "denied" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = (key: ScopeKey) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (done === "approved") {
    return (
      <p className="t-body" style={{ color: "var(--success)" }}>
        已同意。回到终端，它会在几秒内自己进去 —— 这一页可以关掉了。
      </p>
    );
  }
  if (done === "denied") {
    return (
      <p className="t-body" style={{ color: "var(--ink-secondary)" }}>
        已拒绝，那台设备拿不到任何东西。
      </p>
    );
  }

  return (
    <div>
      <fieldset className="mb-5 border-0 p-0">
        <legend className="t-group-label mb-2 px-1">它想要这些权限</legend>
        <div className="inset-group">
          {asked.map((key) => {
            const spec = SCOPES.find((s) => s.key === key);
            if (!spec) return null;
            const on = picked.has(key);
            return (
              <label
                key={key}
                className="inset-row flex cursor-pointer items-start gap-3 px-4 py-3"
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggle(key)}
                  className="mt-1 size-4 shrink-0"
                />
                <span className="min-w-0 flex-1">
                  <span className="t-body flex flex-wrap items-center gap-1.5 font-medium">
                    {spec.label}
                    {spec.danger >= 2 && (
                      <span
                        className="rounded-[var(--radius-pill)] px-1.5 py-0.5 text-[11px]"
                        style={{
                          background: "color-mix(in srgb, var(--danger) 14%, transparent)",
                          color: "var(--danger)",
                        }}
                      >
                        高风险
                      </span>
                    )}
                  </span>
                  <span className="t-caption mt-0.5 block" style={{ color: "var(--ink-secondary)" }}>
                    {spec.detail}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
        <p className="t-caption mt-2 px-1" style={{ color: "var(--ink-secondary)" }}>
          可以只勾一部分。终端用到没勾的那些时会明确告诉你缺哪一项
          {isSsh ? "。SSH 网关这条路上，高风险的那几项根本不在可申请之列" : ""}
        </p>
      </fieldset>

      {error && (
        <p className="t-caption mb-3" style={{ color: "var(--danger)" }} role="alert">
          {error}
        </p>
      )}

      {/*
        两个按钮同宽同高同权重。哪个都不是「主按钮」。
      */}
      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          disabled={pending}
          className={buttonClass("neutral", "md", "w-full")}
          onClick={() =>
            start(async () => {
              setError(null);
              const r = await denyDeviceAction({ code });
              if (r.ok) setDone("denied");
              else setError(r.error ?? "没成功");
            })
          }
        >
          拒绝
        </button>
        <button
          type="button"
          disabled={pending}
          className={buttonClass("neutral", "md", "w-full")}
          onClick={() =>
            start(async () => {
              setError(null);
              const r = await approveDeviceAction({ code, scopes: [...picked] });
              if (r.ok) setDone("approved");
              else setError(r.error ?? "没成功");
            })
          }
        >
          同意
        </button>
      </div>
    </div>
  );
}
