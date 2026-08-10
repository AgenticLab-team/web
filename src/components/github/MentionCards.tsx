import { GitPullRequest, CircleDot, Package } from "lucide-react";

import type { MentionCard } from "@/lib/github/mentions";

/**
 * 帖子底下那一排「提到的项目」。
 *
 * ═════════════════════════════════════════
 * 它是正文的**补充**，不是正文的替身
 * ═════════════════════════════════════════
 *
 * 正文里那条链接原样留着，一个字都不动。这里只是把
 * 「点进去才知道是什么」提前说了一句 —— 因为**大多数人不会点**，
 * 于是「我看到了这条链接」和「我知道它是什么」之间隔着一次跳转，
 * 绝大部分人停在前面那边。
 *
 * 所以它长得要像一条注释，不像一个广告位：
 *
 *   · 排在正文之后、互动栏之前 —— 读完了才补充，不打断阅读
 *   · 没有大图、没有按钮、不抢对比度
 *   · 缓存里没有就整块不出现，**不显示占位骨架** ——
 *     一个永远在转的骨架比没有这块区域更让人分心
 *
 * ═════════════════════════════════════════
 * 为什么不做成一个能点开的浮层
 * ═════════════════════════════════════════
 *
 * 卡片本身就是链接，点了直接去 GitHub。中间再插一层浮层等于
 * 多问一次「你确定要走吗」—— 而人点它的时候已经确定了。
 */

const ICONS = {
  repo: Package,
  issue: CircleDot,
  pr: GitPullRequest,
} as const;

const LABELS = {
  repo: "仓库",
  issue: "issue",
  pr: "PR",
} as const;

export function MentionCards({ cards }: { cards: MentionCard[] }) {
  if (cards.length === 0) return null;

  return (
    <section className="mt-5" aria-labelledby="gh-mentions">
      <h2
        id="gh-mentions"
        className="t-caption2 mb-1.5 font-medium tracking-wide text-[var(--ink-quaternary)]"
      >
        这篇提到的
      </h2>

      <div className="space-y-1.5">
        {cards.map((card) => {
          const Icon = ICONS[card.kind];
          return (
            <a
              key={card.key}
              href={card.url}
              target="_blank"
              /*
               * nofollow：这些地址是别人贴的，我们不替他们背书权重。
               * noopener：不给对方页面拿到 window.opener 的机会。
               */
              rel="noopener noreferrer nofollow"
              className="inset-group flex items-start gap-2.5 px-3 py-2.5 transition active:opacity-60"
            >
              <span
                className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-[var(--ink-tertiary)]"
                style={{ background: "var(--fill)" }}
                aria-hidden
              >
                {/*
                  * 外层 span 已经 aria-hidden 了，子树本来就读不到；
                  * 这里再标一次是为了让扫描器逐个元素也认得出来 ——
                  * 它做不了子树分析，而一个能被「父元素上有」绕过的
                  * 检查，等于对下一个人不成立。
                  */}
                <Icon className="h-3.5 w-3.5" strokeWidth={2.2} aria-hidden />
              </span>

              <span className="min-w-0 flex-1">
                <span className="t-footnote flex items-baseline gap-1.5 font-medium">
                  <span className="min-w-0 truncate">{card.title}</span>
                  {/*
                    * 类型用文字不用只用图标：读屏念不出一个图标，
                    * 而「这是 PR 还是 issue」正是这张卡片最要紧的一件事。
                    */}
                  <span className="t-caption2 shrink-0 font-normal text-[var(--ink-quaternary)]">
                    {LABELS[card.kind]}
                  </span>
                </span>
                {card.summary && (
                  <span className="t-caption2 mt-0.5 block leading-relaxed text-[var(--ink-secondary)]">
                    {card.summary}
                  </span>
                )}
              </span>
            </a>
          );
        })}
      </div>

      {/*
        * 出处要标。这几行字不是作者写的，是我们从 GitHub 拿来的 ——
        * 不说清楚的话，读者会把它当成作者的话。
        */}
      <p className="t-caption2 mt-1.5 text-[var(--ink-quaternary)]">来自 GitHub</p>
    </section>
  );
}
