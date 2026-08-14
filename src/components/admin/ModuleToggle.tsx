"use client";

import { Switch } from "@/components/ui/Switch";
import { useState, useTransition } from "react";

import { AdminActions, AdminButton, adminFieldClass } from "@/components/admin/ui";
import { setModuleEnabled } from "@/lib/modules/actions";

/**
 * 模块开关。
 *
 * 关掉之前**必须写一句理由**，而且要先看到「会连累谁」。
 *
 * 关掉「消息同步」的人往往只想暂停拉取，不知道那会同时让排行榜、签到、
 * 搜索、资源库、雷达全部停在当前这一刻 —— 而那几个模块的开关
 * 看起来还是开着的。所以这里把后果摆在确认框里，而不是等他事后发现。
 *
 * 开启不需要理由：把东西打开是恢复默认状态，风险在另一个方向。
 */
export function ModuleToggle({
  moduleKey,
  name,
  enabled,
  whenOff,
  affects,
  locked,
  lockReason,
}: {
  moduleKey: string;
  name: string;
  enabled: boolean;
  whenOff: string;
  affects: string[];
  locked?: boolean;
  lockReason?: string;
}) {
  const [on, setOn] = useState(enabled);
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function commit(next: boolean, why: string) {
    setError(null);
    startTransition(async () => {
      const result = await setModuleEnabled({ key: moduleKey, enabled: next, reason: why });
      if (result.ok) {
        setOn(next);
        setConfirming(false);
        setReason("");
      } else {
        setError(result.error ?? "操作失败");
      }
    });
  }

  if (locked) {
    return (
      <span className="t-caption2 shrink-0 text-[var(--ink-quaternary)]" title={lockReason}>
        不可关闭
      </span>
    );
  }

  return (
    <>
      <Switch
        on={on}
        onToggle={() => {
          if (on) setConfirming(true);
          else commit(true, "恢复开启");
        }}
        label={name}
        disabled={pending}
      />

      {confirming && (
        <div
          className="mt-2 basis-full rounded-[var(--radius-card)] p-3.5 hairline"
          style={{ background: "color-mix(in srgb, var(--warning) 8%, var(--surface))" }}
        >
          <p className="t-subhead font-medium">关掉「{name}」之后：</p>
          <p className="t-caption mt-1 leading-relaxed text-[var(--ink-secondary)]">{whenOff}</p>

          {/* 会连累谁必须在按下之前就看到 */}
          {affects.length > 0 && (
            <p className="t-caption mt-1.5 leading-relaxed" style={{ color: "var(--danger)" }}>
              <strong>{affects.join("、")}</strong>会跟着停摆 ——
              它们的开关看起来还是开着的，但实际上不会再工作。
            </p>
          )}

          <input
            value={reason}
            autoFocus
            placeholder="为什么要关？（半年后翻日志的人需要知道）"
            onChange={(e) => setReason(e.target.value)}
            className={`mt-2.5 ${adminFieldClass}`}
          />

          <AdminActions className="mt-2">
            <AdminButton
              tone="danger"
              disabled={!reason.trim() || pending}
              onClick={() => commit(false, reason)}
            >
              {pending ? "关闭中…" : "确认关闭"}
            </AdminButton>
            <AdminButton
              tone="quiet"
              disabled={pending}
              onClick={() => {
                setConfirming(false);
                setReason("");
                setError(null);
              }}
            >
              再想想
            </AdminButton>
          </AdminActions>

          {error && (
            <p role="alert" className="t-caption mt-2" style={{ color: "var(--danger)" }}>
              {error}
            </p>
          )}
        </div>
      )}

      {!confirming && error && (
        <p className="t-caption mt-1 basis-full" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      )}
    </>
  );
}
