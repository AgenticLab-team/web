"use client";

import { Check, Lock } from "lucide-react";
import { useState, useTransition } from "react";

import { updateNotificationPrefs } from "@/lib/notifications/actions";
import {
  SECTION_HINTS,
  SECTION_LABELS,
  TYPE_META,
  isAlwaysOn,
  type PrefsMap,
  type TypeMeta,
} from "@/lib/notifications/prefs";

/**
 * 通知开关面板。
 *
 * 交互上的两个决定：
 *
 * **① 改完立刻保存，没有「保存」按钮。**
 * 这一页只有开关，而一个只有开关的页面上，「保存」按钮存在的唯一作用
 * 是让人有机会忘记按它 —— 然后以为自己关掉了，其实没有。
 *
 * **② 关不掉的那几类照样列出来，标一把锁。**
 * 藏起来的话用户会以为这些通知不存在；列出来并说明为什么关不掉，
 * 比悄悄地替他做决定诚实。
 */
export function PrefsPanel({ initial }: { initial: PrefsMap }) {
  const [prefs, setPrefs] = useState(initial);
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function toggle(type: string) {
    if (isAlwaysOn(type)) return;

    // 先动界面再发请求 —— 开关跟手是这类控件唯一重要的手感
    const next: PrefsMap = {
      ...prefs,
      [type]: { ...prefs[type], site: !prefs[type]?.site },
    };
    setPrefs(next);
    setError(null);

    startTransition(async () => {
      const result = await updateNotificationPrefs(next);
      if (result.ok) {
        setSaved(result.note ?? "已保存");
      } else {
        // 失败要把开关**拨回去** —— 停在用户以为生效了的位置是最坏的结果
        setPrefs(prefs);
        setError(result.error ?? "保存失败");
      }
    });
  }

  const sections: TypeMeta["section"][] = ["interaction", "recognition", "account"];

  return (
    <div className="space-y-6">
      {sections.map((section) => (
        <section key={section}>
          <h2 className="t-footnote px-1 font-medium uppercase tracking-wide text-[var(--ink-tertiary)]">
            {SECTION_LABELS[section]}
          </h2>
          <p className="t-caption mb-2 px-1 text-[var(--ink-quaternary)]">
            {SECTION_HINTS[section]}
          </p>

          <div className="inset-group">
            {TYPE_META.filter((m) => m.section === section).map((meta) => {
              const locked = isAlwaysOn(meta.type);
              const on = locked || (prefs[meta.type]?.site ?? true);
              return (
                <div key={meta.type} className="inset-row flex items-start gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="t-body flex items-center gap-1.5">
                      {meta.label}
                      {locked && (
                        <Lock
                          className="h-3 w-3 text-[var(--ink-quaternary)]"
                          strokeWidth={2.2}
                          aria-label="关不掉"
                        />
                      )}
                    </p>
                    <p className="t-caption mt-0.5 leading-relaxed text-[var(--ink-tertiary)]">
                      {meta.hint}
                    </p>
                  </div>

                  <button
                    type="button"
                    role="switch"
                    aria-checked={on}
                    aria-label={meta.label}
                    disabled={locked || pending}
                    onClick={() => toggle(meta.type)}
                    className="relative mt-0.5 h-[31px] w-[51px] shrink-0 rounded-full transition disabled:opacity-45"
                    style={{ background: on ? "var(--success)" : "var(--fill-strong, var(--fill))" }}
                  >
                    <span
                      className="absolute top-[2px] h-[27px] w-[27px] rounded-full bg-white shadow-sm transition-all"
                      style={{ left: on ? "22px" : "2px" }}
                    />
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      ))}

      <div className="px-1">
        {error ? (
          <p className="t-caption" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        ) : saved ? (
          <p
            className="t-caption flex items-center gap-1"
            style={{ color: "var(--ink-tertiary)" }}
          >
            <Check className="h-3.5 w-3.5" strokeWidth={2.4} aria-hidden />
            {saved} · 改动立即生效
          </p>
        ) : (
          <p className="t-caption text-[var(--ink-quaternary)]">改动立即生效，不用另外保存</p>
        )}
      </div>

      <p className="t-caption px-1 leading-relaxed text-[var(--ink-tertiary)]">
        关掉的那段时间里，这类通知<strong>不会被产生</strong> ——
        重新打开也补不回来。这是「关掉」这个词本来的意思，
        也免得你某天看到一个点不掉的红点。
      </p>
    </div>
  );
}
