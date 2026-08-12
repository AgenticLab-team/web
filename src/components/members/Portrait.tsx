import { AtSign, Clock, MessageSquareQuote, Smile } from "lucide-react";
import Link from "next/link";

import { formatWindow, type HourSummary } from "@/lib/members/hours";
import type { CatchphraseView, EmojiView, MentionPartner } from "@/lib/members/phrases";

/**
 * 主页上的「这个人是什么样的」。
 *
 * ═════════════════════════════════════════
 * 原来那四个数字说不出这个人是谁
 * ═════════════════════════════════════════
 *
 * 发言数、被 @ 数、被回复数 —— 它们说得清这个人**有多活跃**，
 * 说不清他是什么样的人。站长要的正是后者。
 *
 * ═════════════════════════════════════════
 * 一条都没有时整块不出现
 * ═════════════════════════════════════════
 *
 * 说话少的人、说话和大家一样的人，本来就归纳不出什么。
 * 硬凑一句只会得到一句谁看了都觉得不像的话 —— 而那会让人
 * 连旁边那几个真数字一起怀疑。
 *
 * 也不显示「暂无数据」：那句话对读者没有任何用处，
 * 只是把一块空地方占住并且说明它是空的。
 */

export function Portrait({
  catchphrase,
  hours,
  emoji,
  partner,
  /** 用来跳到那个人的主页；他没有站内账号也照样跳得过去（主页按 wxId 走） */
  partnerHref,
}: {
  catchphrase: CatchphraseView | null;
  hours: HourSummary | null;
  emoji: EmojiView | null;
  partner: MentionPartner | null;
  partnerHref: string | null;
}) {
  if (!catchphrase && !hours && !emoji && !partner) return null;

  return (
    <div className="mb-4 space-y-2">
      {catchphrase && (
        <div className="inset-group flex items-start gap-2.5 px-3.5 py-3">
          <span
            className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-[var(--accent)]"
            style={{ background: "color-mix(in srgb, var(--accent) 12%, transparent)" }}
            aria-hidden
          >
            <MessageSquareQuote className="h-3.5 w-3.5" strokeWidth={2.2} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="t-caption2 text-[var(--ink-quaternary)]">常挂在嘴边</p>
            <p className="t-body mt-0.5 font-medium">「{catchphrase.phrase}」</p>
            {/*
              * 把依据摆出来：说了多少次、横跨多少天、比别人多几倍。
              *
              * 只给一个词的话，读者没有办法判断这句话有多可信 ——
              * 而它确实可能不准。给了依据，他自己就能看出
              * 「说了 129 次、横跨 12 天」和「说了 5 次」不是一回事。
              */}
            <p className="t-caption2 mt-0.5 text-[var(--ink-tertiary)]">
              说过 {catchphrase.hits} 次 · 横跨 {catchphrase.days} 天 · 是同群其他人的{" "}
              {catchphrase.lift < 10 ? catchphrase.lift.toFixed(1) : Math.round(catchphrase.lift)} 倍
            </p>
          </div>
        </div>
      )}

      {hours && (
        <div className="inset-group flex items-start gap-2.5 px-3.5 py-3">
          <span
            className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-[var(--ink-tertiary)]"
            style={{ background: "var(--fill)" }}
            aria-hidden
          >
            <Clock className="h-3.5 w-3.5" strokeWidth={2.2} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="t-caption2 text-[var(--ink-quaternary)]">一般什么时候说话</p>
            <p className="t-body mt-0.5 font-medium">
              {hours.label ?? "各个时段都有"}
              <span className="t-caption ml-1.5 font-normal text-[var(--ink-tertiary)]">
                {formatWindow(hours.from, hours.to)} 最多
              </span>
            </p>

            {/*
              * 24 根细条，一根一小时。
              *
              * 用 aria-hidden + 上面那句话承担语义：读屏念 24 个数字
              * 是没有意义的，而「傍晚最活跃，18:00–21:00 最多」
              * 已经把这张图说完了。
              *
              * 每根都留一点最小高度（哪怕是 0）—— 全塌下去的话
              * 那一段看起来像是渲染坏了，而不是「这几个小时没人说话」。
              */}
            <div className="mt-2 flex h-6 items-end gap-px" aria-hidden>
              {hours.bars.map((v, h) => (
                <span
                  key={h}
                  className="flex-1 rounded-[1px]"
                  style={{
                    height: `${Math.max(6, v * 100)}%`,
                    background:
                      v > 0
                        ? `color-mix(in srgb, var(--accent) ${Math.round(25 + v * 75)}%, transparent)`
                        : "var(--fill)",
                  }}
                />
              ))}
            </div>
            {/*
              * 标出 0 / 6 / 12 / 18 —— 没有刻度的话，
              * 这排条子只是好看，读不出「几点」。
              */}
            <div className="t-caption2 mt-1 flex justify-between text-[var(--ink-quaternary)]" aria-hidden>
              <span>0</span>
              <span>6</span>
              <span>12</span>
              <span>18</span>
              <span>24</span>
            </div>
          </div>
        </div>
      )}

      {emoji && (
        <div className="inset-group flex items-start gap-2.5 px-3.5 py-3">
          <span
            className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-[var(--ink-tertiary)]"
            style={{ background: "var(--fill)" }}
            aria-hidden
          >
            <Smile className="h-3.5 w-3.5" strokeWidth={2.2} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            {/*
              * 和上面那条分开，因为**它不是他说的话**。
              *
              * 混在一起会得到「他常把旺柴挂在嘴边、说过 52 次」——
              * 而「旺柴」是微信表情，他一个字都没说。
              */}
            <p className="t-caption2 text-[var(--ink-quaternary)]">最常用的表情</p>
            <p className="t-body mt-0.5 font-medium">[{emoji.emoji}]</p>
            <p className="t-caption2 mt-0.5 text-[var(--ink-tertiary)]">
              点过 {emoji.hits} 次
            </p>
          </div>
        </div>
      )}

      {partner && (
        <div className="inset-group flex items-start gap-2.5 px-3.5 py-3">
          <span
            className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-[var(--ink-tertiary)]"
            style={{ background: "var(--fill)" }}
            aria-hidden
          >
            <AtSign className="h-3.5 w-3.5" strokeWidth={2.2} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            {/*
              * 标题是「@ 得最多」，不是「聊得最多」。
              *
              * 群消息的回复关系卡在上游，手上只有 @ ——
              * 写成「聊得最多」就是一句我们答不上来的话：
              * 两个人天天对着聊、一次没 @ 过，这里会说他们不熟。
              */}
            <p className="t-caption2 text-[var(--ink-quaternary)]">@ 得最多</p>
            <p className="t-body mt-0.5 font-medium">
              {partnerHref ? (
                <Link href={partnerHref} className="transition active:opacity-60">
                  {partner.name}
                </Link>
              ) : (
                partner.name
              )}
            </p>
            <p className="t-caption2 mt-0.5 text-[var(--ink-tertiary)]">
              来回 @ 过 {partner.count} 次
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
