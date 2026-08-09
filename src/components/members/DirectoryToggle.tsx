"use client";

import { useState, useTransition } from "react";

import { setDirectoryHidden } from "@/lib/members/actions";

/**
 * 目录隐身开关。
 *
 * 隐身之后**自己那一行还在**（标着「仅自己可见」）——
 * 否则用户没有任何办法确认这个开关生效了，只能靠相信。
 * 而「只能靠相信」的隐私开关，跟没有是一样的。
 */
export function DirectoryToggle({ initial }: { initial: boolean }) {
  const [hidden, setHidden] = useState(initial);
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<string | null>(null);

  function toggle() {
    const next = !hidden;
    setHidden(next);
    setNote(null);
    startTransition(async () => {
      const result = await setDirectoryHidden(next);
      if (result.ok) setNote(result.note ?? null);
      else {
        setHidden(hidden);
        setNote(result.error ?? "保存失败");
      }
    });
  }

  return (
    <div>
      <div className="inset-group">
        <div className="inset-row flex items-start gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="t-body">出现在成员目录里</p>
            <p className="t-caption mt-0.5 leading-relaxed text-[var(--ink-tertiary)]">
              只有和你在同一个群的注册用户看得到，而且不显示是哪个群
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={!hidden}
            aria-label="出现在成员目录里"
            disabled={pending}
            onClick={toggle}
            className="relative mt-0.5 h-[31px] w-[51px] shrink-0 rounded-full transition disabled:opacity-45"
            style={{ background: hidden ? "var(--fill-strong, var(--fill))" : "var(--success)" }}
          >
            {/* 位移走 translateX 不走 left —— 理由见 globals.css 的 .switch-knob */}
            <span
              className="switch-knob absolute left-[2px] top-[2px] h-[27px] w-[27px] rounded-full bg-white shadow-sm"
              style={{ transform: hidden ? "translateX(0)" : "translateX(20px)" }}
            />
          </button>
        </div>
      </div>
      {note && <p className="t-caption mt-2 px-1 text-[var(--ink-tertiary)]">{note}</p>}
    </div>
  );
}
