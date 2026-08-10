/**
 * 14 天趋势条。
 *
 * ─────────────────────────────────────────
 * 每个群按**自己**的最高点归一化
 * ─────────────────────────────────────────
 *
 * 按全站最高点归一化的话，一天两百条的群会把所有小群压成一条平线 ——
 * 而这一页的用处正是横向比较「每个群自己在不在变化」。
 * 一个 30 条/天的群跌到 5 条，和大群跌一半一样要紧。
 *
 * 也就是说：**柱子的高度不能跨群比较，形状可以**。
 * 所以旁边永远跟着一个绝对数字，不让人只看形状下结论。
 */
export function HealthSparkline({ trend, tone }: { trend: number[]; tone: string }) {
  const peak = Math.max(...trend, 1);

  return (
    <div className="flex h-8 items-end gap-[2px]" aria-hidden>
      {trend.map((n, i) => (
        <div
          key={i}
          className="flex-1 rounded-[1px]"
          style={{
            /*
             * 0 也留 2px 的底。
             *
             * 高度按比例算的话，没有消息的那天是 0 像素 —— 于是
             * 中间凭空出现一段空白，看起来像数据缺了一块，
             * 而事实是「那天确实没人说话」，那是**这一页最要紧的信号之一**。
             */
            height: `${Math.max(2, Math.round((n / peak) * 100))}%`,
            background:
              n === 0
                ? "var(--fill-strong)"
                : `color-mix(in oklab, ${tone} ${35 + Math.round((n / peak) * 55)}%, transparent)`,
          }}
        />
      ))}
    </div>
  );
}
