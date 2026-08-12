import { GitPullRequest, CircleDot, Package, GitCommitHorizontal, FileCode2 } from "lucide-react";

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
  commit: GitCommitHorizontal,
  code: FileCode2,
} as const;

const LABELS = {
  repo: "仓库",
  issue: "issue",
  pr: "PR",
  commit: "提交",
  code: "代码",
} as const;

/**
 * 代码那一段单独长一个样子。
 *
 * ─────────────────────────────────────────
 * 它不是一整块可点的链接
 * ─────────────────────────────────────────
 *
 * 别的卡片整块是 `<a>`，因为它们要说的话一行就说完了，
 * 人看完唯一想做的事就是点过去。代码这一段反过来 ——
 * **它把答案直接摆出来了**，多数人看完就不必去 GitHub 了。
 * 整块做成链接的话，想复制其中两行的人一选中就会跳走。
 *
 * 所以只有顶上那行标题是链接，代码本身是纯内容，选得动、复制得走。
 *
 * ─────────────────────────────────────────
 * 横向滚动要收在这一块里
 * ─────────────────────────────────────────
 *
 * 代码有长行，而页面本身**绝不能**横向滚动 —— 一旦整页能横拉，
 * 手机上每一次划动都会歪。`overflow-x-auto` 挂在这一层，
 * 长行在这块里自己滚。
 */
function CodeCard({ card, Icon }: { card: MentionCard; Icon: (typeof ICONS)[keyof typeof ICONS] }) {
  return (
    <div className="inset-group overflow-hidden">
      <a
        href={card.url}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="flex min-h-11 items-center gap-2.5 px-3 py-2.5 transition active:opacity-60"
      >
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-[var(--ink-tertiary)]"
          style={{ background: "var(--fill)" }}
          aria-hidden
        >
          <Icon className="h-3.5 w-3.5" strokeWidth={2.2} aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="t-footnote flex items-baseline gap-1.5 font-medium">
            <span className="min-w-0 truncate">{card.title}</span>
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

      {/*
        * 这段 HTML 是我们自己在取回来的时候高亮好并**消过毒**的
        * （见 lib/github/code-render.ts —— 走的是帖子正文那同一个
        * sanitizeHtml，不是另写一份白名单）。
        */}
      <div
        /* hairline-t 而不是 border-t —— 手拼的边框是 1px，
           和旁边所有 0.5px 的分隔线粗细不一样，高分屏上一眼看得出来 */
        className="hairline-t prose-forum t-caption2 overflow-x-auto px-3 py-2 leading-relaxed"
        dangerouslySetInnerHTML={{ __html: card.body! }}
      />
    </div>
  );
}

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
          if (card.kind === "code" && card.body) {
            return <CodeCard key={card.key} card={card} Icon={Icon} />;
          }
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
