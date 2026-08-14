import Link from "next/link";

/**
 * 404 那一页的内容本身，**不带最外面那层容器**。
 *
 * ═════════════════════════════════════════
 * 为什么要拆出来：同一个 404 有两条路径，形状不一样
 * ═════════════════════════════════════════
 *
 * · 敲错一个地址（`/zzz`）—— 命中根布局下的 `not-found.tsx`，
 *   不带导航外壳，页面自己就是最外层
 * · 一个**存在的路由**里调了 `notFound()`（比如被功能开关关掉的
 *   `/shop`、`/radar`）—— 它在 `(app)` 分组里，**外壳照常渲染**，
 *   而 `AppShell` 自己已经有一个 `<main>` 了
 *
 * 原来只有一份 `not-found.tsx`，自带 `<main>`。于是第二条路径上
 * 出现了**两个 main 地标** —— 读屏用户的「跳到正文」变成一次猜。
 *
 * 而这件事在页面上一点都看不出来（两个 main 长得像一个），
 * 是把无障碍树拉出来才看见的（`scripts/ax-audit.mjs`）。
 *
 * 顺带说清一件原来注释里写错的事：那份注释说「这一页在根布局下，
 * 不带导航外壳」。对**敲错地址**那条路径成立，对 `notFound()`
 * 那条**不成立** —— 实测 `/shop` 上侧栏、底部导航一个不少。
 */
export function NotFoundBody() {
  return (
    <>
      <p className="t-subhead text-[var(--ink-tertiary)]">404</p>
      <h1 className="t-title1 mt-1">这个地址没有东西</h1>
      <p className="t-body mt-3 leading-relaxed text-[var(--ink-secondary)]">
        可能是地址敲错了，也可能是这条链接指向的内容已经被删掉或者转成了仅成员可见。
      </p>

      <nav className="mt-8 flex flex-col gap-2">
        <Exit href="/" title="回首页" hint="社区脉搏、榜单、我在的群" />
        <Exit href="/forum" title="去论坛" hint="看看大家最近在聊什么" />
        <Exit href="/search" title="搜一下" hint="记得关键词的话，直接搜比翻更快" />
      </nav>

      <p className="t-caption mt-8 text-[var(--ink-tertiary)]">
        如果你是从别人分享的链接点进来的，可以回去问一句 ——
        有些内容只对群成员开放。
      </p>
    </>
  );
}

function Exit({ href, title, hint }: { href: string; title: string; hint: string }) {
  return (
    <Link
      href={href}
      className="inset-row flex items-center justify-between gap-3 rounded-[var(--radius-card)] bg-[var(--surface)] px-4 py-3 transition-colors hover:bg-[var(--fill)]"
    >
      <span className="min-w-0">
        <span className="t-subhead block font-medium">{title}</span>
        <span className="t-caption block text-[var(--ink-tertiary)]">{hint}</span>
      </span>
      <span className="t-body shrink-0 text-[var(--ink-quaternary)]" aria-hidden>
        ›
      </span>
    </Link>
  );
}
