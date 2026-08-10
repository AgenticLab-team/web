import Link from "next/link";

import type { DayCurve as Curve } from "@/lib/messages/day-curve";

/**
 * 一天的活跃度曲线，每一格可点。
 *
 * ─────────────────────────────────────────
 * 它是导航，不是装饰
 * ─────────────────────────────────────────
 *
 * 只画一条曲线的话，人看完还是得自己翻几十页 ——
 * 那只是把「不知道讨论在哪」变成「知道在哪但还是够不着」。
 *
 * 所以每一格链到 `?m=<那个小时第一条消息的 id>`：
 * 已有的定位那一套会算出页码、渲染那一页、高亮那一条，
 * 浏览器再原生滚过去。链接可以收藏、分享、刷新。
 *
 * ─────────────────────────────────────────
 * 空的那几格也要留着
 * ─────────────────────────────────────────
 *
 * 只画有消息的小时，格子数会随每天不同 —— 于是两天之间没法比，
 * 而「凌晨三点没人说话」本身就是这一天的形状的一部分。
 * 所以 24 格恒定，空的那几格保持 2px 的底、不可点。
 */
export function DayCurve({
  curve,
  group,
  order,
}: {
  curve: Curve;
  group: string;
  /** 排序要带过去 —— 丢掉的话点一下曲线就被打回默认排序 */
  order?: string;
}) {
  if (curve.total === 0) return null;

  const peak = Math.max(...curve.hours.map((h) => h.count), 1);

  const href = (id: string) => {
    const params = new URLSearchParams({ group, m: id });
    if (order) params.set("order", order);
    return `/archive?${params.toString()}`;
  };

  return (
    <section className="mb-3" aria-label="这一天的活跃度">
      <div className="mb-1.5 flex items-baseline justify-between gap-3 px-1">
        <p className="t-caption text-[var(--ink-secondary)]">
          这一天 {curve.total.toLocaleString("zh-CN")} 条
          {curve.peakHour !== null && (
            <span className="text-[var(--ink-tertiary)]">
              {" "}
              · 最集中在 {curve.peakHour}:00
            </span>
          )}
        </p>
        <p className="t-caption2 text-[var(--ink-tertiary)]">点柱子跳到那个时段</p>
      </div>

      <div className="flex h-12 items-end gap-[2px]">
        {curve.hours.map((h) => {
          const height = `${Math.max(2, Math.round((h.count / peak) * 100))}%`;

          if (!h.firstId) {
            return (
              <div
                key={h.hour}
                className="flex-1 rounded-[2px] bg-[var(--fill)]"
                style={{ height: "2px" }}
                aria-hidden
              />
            );
          }

          return (
            <Link
              key={h.hour}
              href={href(h.firstId)}
              // 柱子本身很窄，可点区域靠 flex-1 撑满整格宽度
              className="group flex-1 rounded-[2px] transition-colors"
              style={{
                height,
                background:
                  h.hour === curve.peakHour
                    ? "var(--accent)"
                    : "color-mix(in oklab, var(--accent) 30%, transparent)",
              }}
              // 读屏软件读到的是「14:00，283 条」，不是一个没有名字的链接
              aria-label={`${h.hour}:00，${h.count} 条`}
              title={`${h.hour}:00 · ${h.count} 条`}
            />
          );
        })}
      </div>

      <div className="mt-1 flex justify-between px-[1px]">
        {[0, 6, 12, 18].map((h) => (
          <span key={h} className="t-caption2 text-[var(--ink-tertiary)]">
            {h}:00
          </span>
        ))}
        <span className="t-caption2 text-[var(--ink-tertiary)]">24:00</span>
      </div>
    </section>
  );
}
