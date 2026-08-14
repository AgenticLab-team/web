"use client";

import { useState, useTransition } from "react";

import { setPrivacySwitch } from "@/lib/privacy/actions";
import type { PrivacyKey } from "@/lib/privacy/rules";
import { Switch } from "@/components/ui/Switch";

/**
 * 一个隐私开关。
 *
 * ─────────────────────────────────────────
 * 界面上一律用肯定句
 * ─────────────────────────────────────────
 *
 * 库里存的是 `hide_*`，而开关问的是「要不要出现」。
 * 照字段直译会得到「隐藏我的榜单排名」这种开关 ——
 * 于是「打开」等于「藏起来」，没有人能一眼读对。
 * 翻转只在 `rules.ts` 里做一次，这里拿到的已经是「开 = 出现」。
 *
 * ─────────────────────────────────────────
 * 乐观更新，失败要退回去
 * ─────────────────────────────────────────
 *
 * 隐私开关尤其不能「点了看起来生效了、其实没存上」——
 * 那正是这一整块要治的病。所以失败时把界面拨回原样并说出来，
 * 而不是留着一个看起来已经关掉的开关。
 */
export function PrivacyToggle({
  switchKey,
  on: initial,
  label,
  detail,
  limit,
}: {
  switchKey: PrivacyKey;
  on: boolean;
  label: string;
  detail: string;
  limit: string;
}) {
  const [on, setOn] = useState(initial);
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<string | null>(null);

  function toggle() {
    const next = !on;
    setOn(next);
    setNote(null);
    startTransition(async () => {
      const result = await setPrivacySwitch(switchKey, next);
      if (result.ok) setNote(result.note);
      else {
        setOn(!next);
        setNote(result.error);
      }
    });
  }

  return (
    <div className="inset-group">
      <div className="inset-row flex items-start gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="t-body">{label}</p>
          <p className="t-caption mt-0.5 leading-relaxed text-[var(--ink-tertiary)]">{detail}</p>
        </div>
        <Switch on={on} onToggle={toggle} label={label} disabled={pending} className="mt-0.5" />
      </div>

      {/*
        * 「它不管什么」只在关掉之后才显示。
        *
        * 一直显示的话，一个从来没打算关的人要先读两段免责声明；
        * 而真正需要看到这句话的，恰恰是刚刚关掉、正准备
        * 照着这层保护去说话的那个人。
        */}
      {!on && (
        <div className="inset-row px-4 py-2.5">
          <p className="t-caption2 leading-relaxed text-[var(--ink-tertiary)]">{limit}</p>
        </div>
      )}

      {note && (
        <div className="inset-row px-4 py-2.5">
          <p className="t-caption2 text-[var(--ink-tertiary)]" role="status">
            {note}
          </p>
        </div>
      )}
    </div>
  );
}
