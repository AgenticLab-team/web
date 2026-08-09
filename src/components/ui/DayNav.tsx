import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";

import { shiftDateKey, todayKey } from "@/lib/time";

/**
 * 按天翻的导航。
 *
 * ─────────────────────────────────────────
 * 同一件事原来有两套长相
 * ─────────────────────────────────────────
 *
 * `/archive` 用的是吸顶的 chrome 条配左右箭头，
 * `/forum/convert` 用的是两个写着「前一天/后一天」的药丸链接。
 * 功能一模一样，外观完全不同 —— 在两页之间来回的人会觉得
 * 自己走进了另一个网站。这正是「割裂」最具体的样子。
 *
 * 合成一个之后取的是 archive 那版：箭头比文字窄，
 * 中间才留得下日期；而且它有 `aria-disabled`，
 * 药丸那版只是把颜色调淡，读屏软件照样会念「后一天，链接」。
 *
 * ─────────────────────────────────────────
 * 加一个直接跳日期的口子
 * ─────────────────────────────────────────
 *
 * 两版都只能 ±1 天。要回到上个月得点三十下 ——
 * 而人想找的东西通常就在「上个月某天」。
 *
 * 原生 `<input type="date">` + GET 表单，不需要一行 JS：
 * 手机上会弹系统日期选择器，桌面上是日历控件。
 * 自己搓一个日历要几百行，还要处理时区、键盘、读屏 ——
 * 而系统那个每一样都已经对了。
 */

/** 「今天」「昨天」比一串数字好认 —— 光看 2026-08-09 得在脑子里算一下 */
function relativeLabel(day: string, today: string): string | null {
  if (day === today) return "今天";
  if (day === shiftDateKey(today, -1)) return "昨天";
  if (day === shiftDateKey(today, -2)) return "前天";
  return null;
}

export function DayNav({
  day,
  href,
  /** 表单要提交到哪个路由 */
  action,
  /** 一起带过去的筛选参数（群、版块之类）—— 翻天不该把筛选丢掉 */
  hidden = {},
  label = "按天翻看",
}: {
  day: string;
  href: (date: string) => string;
  action: string;
  hidden?: Record<string, string | undefined>;
  label?: string;
}) {
  const today = todayKey();
  const isToday = day >= today;
  const relative = relativeLabel(day, today);

  return (
    <nav
      aria-label={label}
      /*
       * 吸顶。翻天是这两页的主操作，不该滚到底才找得到。
       * top-12 让开顶部那条 chrome。
       */
      className="chrome sticky top-12 z-10 mb-4 flex items-center justify-between gap-2 rounded-[var(--radius-control)] px-2 py-2"
    >
      <Link
        href={href(shiftDateKey(day, -1))}
        aria-label="前一天"
        className="inline-flex items-center rounded-[var(--radius-control)] p-2 transition hover:bg-[var(--fill)] active:scale-95"
      >
        <ChevronLeft className="h-4 w-4" strokeWidth={2.2} aria-hidden />
      </Link>

      <form method="get" action={action} className="flex min-w-0 items-baseline gap-1.5">
        {Object.entries(hidden).map(([name, value]) =>
          value ? <input key={name} type="hidden" name={name} value={value} /> : null,
        )}
        {relative && <span className="t-caption text-[var(--ink-tertiary)]">{relative}</span>}
        {/*
          * 日期本身就是输入框。
          *
          * 做成「一个只读的日期 + 旁边一个日历按钮」的话要多点一下,
          * 而这一行的全部意义就是让人少点几下。
          * onChange 自动提交需要 JS，所以留一个提交按钮兜底 ——
          * 微信 webview 上原生日期控件的行为不完全一致。
          */}
        <input
          type="date"
          name="date"
          defaultValue={day}
          max={today}
          aria-label="跳到某一天"
          className="tabular t-subhead bg-transparent font-medium outline-none"
        />
        <button
          type="submit"
          className="t-caption2 rounded-[var(--radius-control)] px-1.5 py-0.5 text-[var(--ink-tertiary)] transition hover:bg-[var(--fill)]"
        >
          跳转
        </button>
      </form>

      <Link
        href={isToday ? href(day) : href(shiftDateKey(day, 1))}
        aria-label="后一天"
        aria-disabled={isToday}
        /*
         * 到今天就停住。
         *
         * 未来的日期一定是空的，而一个能点、点了什么都没有的按钮
         * 会让人以为数据丢了。pointer-events-none 之外还要 aria-disabled ——
         * 只调淡颜色的话，读屏软件照样会念「后一天，链接」。
         */
        className={`inline-flex items-center rounded-[var(--radius-control)] p-2 transition ${
          isToday ? "pointer-events-none opacity-30" : "hover:bg-[var(--fill)] active:scale-95"
        }`}
      >
        <ChevronRight className="h-4 w-4" strokeWidth={2.2} aria-hidden />
      </Link>
    </nav>
  );
}
