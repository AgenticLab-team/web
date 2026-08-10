import type { OwnedTitle } from "@/lib/titles/queries";

/**
 * 主页上的称号。
 *
 * ═════════════════════════════════════════
 * 称号系统整套都在，唯独没人看得见
 * ═════════════════════════════════════════
 *
 * 获取、购买、续期、赛季结算、过期回收 —— 全都做了，
 * 而**称号只出现在本人的设置页里**。
 * 一个只有自己看得见的荣誉，等于没有荣誉：
 * 它存在的全部理由就是被别人看到。
 *
 * ═════════════════════════════════════════
 * 佩戴的那个排第一
 * ═════════════════════════════════════════
 *
 * 一个人可能有七八个称号。全部平铺的话，他自己挑出来
 * 「我想让人看见这个」的那一个就被淹没了 —— 而那次挑选
 * 是这个系统里唯一一处本人的表达。
 */

/** 最多摆几个。再多就从一行荣誉变成一片噪声 */
const MAX_SHOWN = 4;

export function TitleRow({ titles }: { titles: OwnedTitle[] }) {
  if (titles.length === 0) return null;

  // 佩戴中的排最前，其余按拿到的时间倒序
  const sorted = [...titles].sort(
    (a, b) => Number(b.equipped) - Number(a.equipped) || b.createdAt - a.createdAt,
  );
  const shown = sorted.slice(0, MAX_SHOWN);
  const rest = sorted.length - shown.length;

  return (
    <div className="mb-4 flex flex-wrap items-center gap-1.5">
      {shown.map((t) => (
        <span
          key={t.userTitleId}
          /*
           * `title` 属性放描述：称号名往往只有两三个字，
           * 光看名字看不出它是怎么来的。
           */
          title={t.description ?? undefined}
          className={`t-caption2 inline-flex items-center gap-1 rounded-[var(--radius-pill)] px-2.5 py-1 ${
            t.equipped ? "font-medium text-[var(--accent)]" : "text-[var(--ink-secondary)]"
          }`}
          style={{
            background: t.equipped
              ? "color-mix(in srgb, var(--accent) 12%, transparent)"
              : "var(--fill)",
          }}
        >
          {/*
            * 图标是称号自己带的 emoji。没有就不占位 ——
            * 一个空的图标位会让这一排看起来参差不齐。
            */}
          {t.icon && <span aria-hidden>{t.icon}</span>}
          {t.name}
        </span>
      ))}
      {rest > 0 && (
        <span className="t-caption2 text-[var(--ink-quaternary)]">还有 {rest} 个</span>
      )}
    </div>
  );
}
