"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { useToast } from "@/components/ui/Toast";
import { changeSetting, resetSetting } from "@/lib/admin/setting-actions";
import type { SettingRow as Row } from "@/lib/admin/settings";

/**
 * 单个配置项。
 *
 * 三条交互决定它是不是真的能用：
 *
 *   ① **被改过的项要一眼看出来。** 一屏几十个配置里真正被动过的只有三五个，
 *      而那三五个才是排查问题时该看的。
 *   ② **「不会追溯」的提醒在改动的那一刻出现**，不是保存后给一句 toast ——
 *      那时人已经点完了。
 *   ③ **危险项不给输入框**，直接引导去复核队列。给了输入框再拒绝，
 *      只会让人觉得系统在耍他。
 */
export function SettingItem({ row }: { row: Row }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(row.value);
  const [reason, setReason] = useState("");

  const changed = value !== row.value;

  const run = (fn: () => Promise<{ ok: boolean; error?: string; note?: string }>) => {
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        toast.show({ message: result.error ?? "保存失败", kind: "error" });
        return;
      }
      toast.show({ message: result.note ?? "已保存", kind: "success" });
      setOpen(false);
      setReason("");
      router.refresh();
    });
  };

  return (
    <div className="inset-row px-4 py-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="t-body flex flex-wrap items-center gap-1.5">
            <span className="truncate">{row.label ?? row.key}</span>
            {row.modified && (
              <span className="t-caption2 rounded-[var(--radius-pill)] bg-[var(--fill)] px-1.5 py-0.5 text-[var(--ink-tertiary)]">
                已改
              </span>
            )}
            {row.dangerous && (
              <span className="t-caption2 font-medium" style={{ color: "var(--danger)" }}>
                需双人复核
              </span>
            )}
          </p>
          {row.description && (
            <p className="t-caption mt-0.5 leading-relaxed text-[var(--ink-tertiary)]">
              {row.description}
            </p>
          )}
          <p className="t-caption2 mt-0.5 font-mono text-[var(--ink-quaternary)]">{row.key}</p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span className="tabular t-subhead">{row.value}</span>
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="t-caption rounded-[var(--radius-pill)] bg-[var(--fill)] px-2.5 py-1 text-[var(--ink-secondary)]"
          >
            {open ? "收起" : "修改"}
          </button>
        </div>
      </div>

      {open && (
        <div className="animate-rise mt-2.5 space-y-2">
          {row.dangerous ? (
            // 给了输入框再拒绝，只会让人觉得系统在耍他
            <p
              className="t-caption rounded-[var(--radius-control)] px-3 py-2 leading-relaxed"
              style={{
                background: "color-mix(in srgb, var(--danger) 8%, transparent)",
                color: "var(--danger)",
              }}
            >
              这一项改错会<strong>静默影响所有人</strong>，而且不会有人立刻发现 ——
              请到「危险操作复核」里发起，需要另一个人批准。
            </p>
          ) : (
            <>
              <input
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className={`${row.type === "int" ? "tabular " : ""}${inputClass}`}
                placeholder={row.defaultValue ?? ""}
              />

              <p className="t-caption2 text-[var(--ink-quaternary)]">
                类型 {row.type}
                {row.minValue !== null && ` · 不小于 ${row.minValue}`}
                {row.maxValue !== null && ` · 不大于 ${row.maxValue}`}
                {row.defaultValue !== null && ` · 默认 ${row.defaultValue}`}
                {row.changeCount > 0 && ` · 改过 ${row.changeCount} 次`}
                {row.updatedByName && ` · 上次由 ${row.updatedByName} 修改`}
              </p>

              {/* 提醒在改动的那一刻出现，不是保存后 —— 那时人已经点完了 */}
              {changed && row.retroactive && (
                <p
                  className="t-caption rounded-[var(--radius-control)] px-3 py-2 leading-relaxed"
                  style={{
                    background: "color-mix(in srgb, var(--warning) 10%, transparent)",
                    color: "var(--warning)",
                  }}
                >
                  这一项<strong>不会追溯历史数据</strong>。已经入库的记录还是按旧规则算的，
                  榜单和当前规则会对不上 —— 要一致的话，改完还得跑一次重算。
                </p>
              )}

              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="理由（必填，会记入变更历史）"
                className={inputClass}
              />

              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={pending || !changed || !reason.trim()}
                  onClick={() => run(() => changeSetting({ key: row.key, value, reason }))}
                  className="t-subhead flex-1 rounded-[var(--radius-control)] bg-[var(--accent)] px-4 py-2 font-medium text-[var(--accent-ink)] disabled:opacity-40"
                >
                  保存
                </button>
                {row.modified && (
                  <button
                    type="button"
                    disabled={pending || !reason.trim()}
                    onClick={() => run(() => resetSetting({ key: row.key, reason }))}
                    className="t-subhead rounded-[var(--radius-control)] bg-[var(--fill)] px-4 py-2 text-[var(--ink-secondary)] disabled:opacity-40"
                  >
                    恢复默认
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const inputClass =
  "t-subhead w-full rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 outline-none placeholder:text-[var(--ink-quaternary)]";
