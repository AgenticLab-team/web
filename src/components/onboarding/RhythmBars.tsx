/**
 * 一天 24 小时的说话节奏。
 *
 * ─────────────────────────────────────────
 * 新人最想知道的其实是「什么时候说话有人接」
 * ─────────────────────────────────────────
 *
 * 「这个群有 11,631 条消息」对一个刚进来的人几乎没有用。
 * 「大家一般晚上九点到十一点在」才是他能拿来用的 ——
 * 他会挑那个时段开口，而不是上午十点发一条然后石沉大海。
 *
 * ─────────────────────────────────────────
 * 为什么不用图表库
 * ─────────────────────────────────────────
 *
 * 24 个 div 就够了。为一屏静态柱子引一个图表库，
 * 会给每个手机用户多下几十 KB，而这一页恰恰是新人打开的第一页。
 */
export function RhythmBars({ hours }: { hours: number[] }) {
  const peak = Math.max(...hours, 1);
  const busiest = hours.indexOf(Math.max(...hours));

  return (
    <div>
      <div className="flex h-16 items-end gap-[2px]" aria-hidden>
        {hours.map((n, h) => (
          <div
            key={h}
            className="flex-1 rounded-[2px] transition-colors"
            style={{
              /*
               * 最矮也留 2px。
               *
               * 高度按比例算的话，凌晨那几格会变成 0 像素 ——
               * 于是柱子中间凭空出现一段空白，看起来像数据缺了一块，
               * 而事实是「那个点确实没人说话」。留一道底线才说得清。
               */
              height: `${Math.max(2, Math.round((n / peak) * 100))}%`,
              background:
                h === busiest ? "var(--accent)" : "color-mix(in oklab, var(--accent) 22%, transparent)",
            }}
          />
        ))}
      </div>

      {/*
        只标 0/6/12/18 四个刻度。
        24 个数字在手机上会挤成一团黑边，反而谁也读不出来。
      */}
      <div className="mt-1.5 flex justify-between px-[1px]">
        {[0, 6, 12, 18].map((h) => (
          <span key={h} className="t-caption2 text-[var(--ink-tertiary)]">
            {h}:00
          </span>
        ))}
        <span className="t-caption2 text-[var(--ink-tertiary)]">24:00</span>
      </div>
    </div>
  );
}
