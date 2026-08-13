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

            {/*
              * ═════════════════════════════════════════
              * 词的**大小**就是它的分量
              * ═════════════════════════════════════════
              *
              * 站长两句话：「怎么还有一个，3～5 个左右」「现在没有艺术效果」。
              *
              * 排成一行等大的词是一张列表，读起来是「这个人说过这些」。
              * 而按分数缩放之后，一眼看过去就能感觉到**哪个才是他** ——
              * 排版本身在传信息，不是在装饰。这也是为什么不做成
              * 真正的词云：词云为了填满形状会把小词放大、把位置打乱，
              * 那时候大小就不再意味着任何东西了。
              *
              * 只缩到 0.72 倍为止。再小就不像一个词、像一处噪点，
              * 而这几个词每一个都够格出现在这里 —— 它们只是没那么突出。
              */}
            <p className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
              {[catchphrase, ...catchphrase.more].map((c, i) => (
                <span
                  key={c.phrase}
                  className={i === 0 ? "font-medium" : ""}
                  style={{
                    fontSize: `${(1 - i * 0.07).toFixed(2)}rem`,
                    color: i === 0 ? "var(--ink)" : "var(--ink-secondary)",
                  }}
                  title={`说过 ${c.hits} 次 · 横跨 ${c.days} 天`}
                >
                  「{c.phrase}」
                </span>
              ))}
            </p>
            {/*
              * 把依据摆出来：说了多少次、横跨多少天、比别人多几倍。
              *
              * 只给一个词的话，读者没有办法判断这句话有多可信 ——
              * 而它确实可能不准。给了依据，他自己就能看出
              * 「说了 129 次、横跨 12 天」和「说了 5 次」不是一回事。
              */}
            {/*
              * 依据只给**排第一的那个**。
              *
              * 五个词各带一行「说过 N 次、横跨 M 天、是别人的 K 倍」
              * 会把这一块变成一张表格，而这一块要的是一眼的印象。
              * 其余几个的数字挂在 title 上，想知道的人悬停就有。
              */}
            <p className="t-caption2 mt-1 text-[var(--ink-tertiary)]">
              「{catchphrase.phrase}」说过 {catchphrase.hits} 次 · 横跨 {catchphrase.days} 天 ·
              是同群其他人的{" "}
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

            {/*
              * 两种表情**长得不一样，不能一起套方括号**。
              *
              * 微信自带的同步下来是 `旺柴` 这种词，写成「[旺柴]」正是
              * 它在聊天框里的样子；而真的 emoji 是 😭 本身，
              * 套上方括号会变成「[😭]」—— 看起来像渲染坏了。
              *
              * 原来只认前一种，线上量过：Unicode 那半边有 1394 个，
              * 和方括号的 1604 个几乎一样多，也就是说**一半的表情
              * 从来没被统计过**，而被漏掉的那些个人特色更强
              * （有人光 🐟 就发了 150 次）。
              */}
            <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1">
              {[emoji, ...emoji.more].map((e, i) => {
                const unicode = /\p{Extended_Pictographic}/u.test(e.emoji);
                return (
                  <span
                    key={e.emoji}
                    className={i === 0 ? "font-medium" : "text-[var(--ink-secondary)]"}
                    // emoji 本身要比方括号词大一点，不然一行里两种混着看很乱
                    style={{ fontSize: `${((unicode ? 1.25 : 1) * (1 - i * 0.07)).toFixed(2)}rem` }}
                    title={`点过 ${e.hits} 次`}
                  >
                    {unicode ? e.emoji : `[${e.emoji}]`}
                  </span>
                );
              })}
            </p>

            <p className="t-caption2 mt-1 text-[var(--ink-tertiary)]">
              最多的那个点过 {emoji.hits} 次
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
