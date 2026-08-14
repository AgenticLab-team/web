"use client";

import { Switch } from "@/components/ui/Switch";
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
 *
 * **③ 推送开关只在「站内开着」时出现。**
 * 站内关掉意味着这类通知根本不产生，推送自然无从谈起 ——
 * 一个拨了没反应的推送开关只会教人怀疑其它开关也是假的。
 * showPush 由服务端判断（订阅了设备的人才看得到），
 * 没订推送的人不该被两列开关加倍地烦。
 */
export function PrefsPanel({ initial, showPush = false }: { initial: PrefsMap; showPush?: boolean }) {
  const [prefs, setPrefs] = useState(initial);
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function toggle(type: string, channel: "site" | "push" = "site") {
    // 「关不掉」只锁站内那一份记录；推不推锁屏由用户全权决定
    if (channel === "site" && isAlwaysOn(type)) return;

    const entry = prefs[type] ?? { site: true, email: false, push: true };
    // 先动界面再发请求 —— 开关跟手是这类控件唯一重要的手感
    const next: PrefsMap = {
      ...prefs,
      [type]: { ...entry, [channel]: !entry[channel] },
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
              const pushOn = prefs[meta.type]?.push ?? true;
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
                    {showPush && on && (
                      <label className="mt-1.5 flex w-fit items-center gap-2">
                        <Switch
                          on={pushOn}
                          onToggle={() => toggle(meta.type, "push")}
                          label={`${meta.label} · 推送到设备`}
                          disabled={pending}
                          size="sm"
                        />
                        <span className="t-caption text-[var(--ink-tertiary)]">推送到设备</span>
                      </label>
                    )}
                  </div>

                  <Switch
                    on={on}
                    onToggle={() => toggle(meta.type, "site")}
                    label={meta.label}
                    disabled={pending}
                    className="mt-0.5"
                  />
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
