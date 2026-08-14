"use client";

import { CalendarClock } from "lucide-react";
import { useState } from "react";

import { MIN_LEAD_MS, scheduleNote, whoCanSeeBeforePublish } from "@/lib/forum/schedule-rules";

/**
 * 「等一会儿再发」。
 *
 * ─────────────────────────────────────────
 * 默认关着，而且关着的时候只有一行字
 * ─────────────────────────────────────────
 *
 * 绝大多数帖子是写完就发的。把一个日期时间选择器常驻在发布按钮
 * 上面，等于让每一个不需要它的人每次都要跳过它。
 *
 * ─────────────────────────────────────────
 * 两句话必须写出来
 * ─────────────────────────────────────────
 *
 * · **最多晚五分钟**。定时发布挂在五分钟一轮的定时任务上。
 *   不说的话，定 09:00 的人会在 09:01 发现没发出去，以为坏了 ——
 *   而再等四分钟就好。
 * · **版主看得见**。等待发布的帖子存成草稿，而草稿对版主是放行的。
 *   想定时公布一个结果的人有权先知道这件事，
 *   而不是在结果提前走漏之后才发现。
 */
export function SchedulePicker({
  value,
  onChange,
}: {
  /** 本地时间字符串（datetime-local 的格式），空表示不定时 */
  value: string;
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(Boolean(value));

  /*
   * `min` 在**点开的那一刻**算。
   *
   * 渲染期读时钟是不纯的，而且它拦得对：服务端渲染出来的那个值
   * 到了浏览器里已经过期了。事件回调里读时钟没有这个问题，
   * 而且那正是这个值唯一需要新鲜的时刻 —— 人刚要挑时间。
   *
   * 它只是浏览器层的一道提示，服务端仍然会再判一次（checkSchedule）。
   */
  const [minAt, setMinAt] = useState("");
  const openPicker = () => {
    setMinAt(localInputValue(Date.now() + MIN_LEAD_MS));
    setOpen(true);
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={openPicker}
        className="tap-target t-caption inline-flex items-center gap-1.5 text-[var(--ink-tertiary)] underline-offset-4 transition hover:text-[var(--ink-secondary)] hover:underline"
      >
        <CalendarClock className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
        等一会儿再发
      </button>
    );
  }

  return (
    <div className="rounded-[var(--radius-control)] bg-[var(--fill)] p-3">
      <label
        htmlFor="schedule-at"
        className="t-subhead flex items-center gap-1.5 font-medium"
      >
        <CalendarClock className="h-4 w-4 text-[var(--ink-tertiary)]" strokeWidth={2} aria-hidden />
        定时发布
      </label>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {/*
          * 原生 datetime-local。
          *
          * 手机上弹系统日期时间选择器，桌面上是原生控件 ——
          * 自己搓一个要处理时区、键盘、读屏，而系统那个每一样都已经对了。
          * min 让浏览器先挡一道，服务端仍然会再判一次。
          */}
        <input
          id="schedule-at"
          type="datetime-local"
          value={value}
          min={minAt || undefined}
          onChange={(e) => onChange(e.target.value)}
          className="t-body rounded-[var(--radius-control)] border border-[var(--separator)] bg-[var(--canvas)] px-2.5 py-2 outline-none focus:border-[var(--accent)]"
        />
        <button
          type="button"
          onClick={() => {
            onChange("");
            setOpen(false);
          }}
          className="t-caption px-2 py-1.5 text-[var(--ink-tertiary)]"
        >
          不定时了
        </button>
      </div>

      <p className="t-caption2 mt-2 leading-relaxed text-[var(--ink-tertiary)]">
        {scheduleNote()}
        <br />
        {whoCanSeeBeforePublish()}
      </p>
    </div>
  );
}

/**
 * 毫秒转成 `datetime-local` 要的那种本地时间字符串。
 *
 * `toISOString()` 给的是 UTC —— 直接切前 16 位会让控件里显示的时间
 * 比用户所在时区早八小时，而人多半会以为是自己填错了。
 */
function localInputValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
