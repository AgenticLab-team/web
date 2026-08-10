import Link from "next/link";

/**
 * 404。
 *
 * ─────────────────────────────────────────
 * 在这之前，这里是 Next 自带的那一页
 * ─────────────────────────────────────────
 *
 * 一个中文社区站，敲错一个地址得到的是
 * 「404: This page could not be found.」——
 * 黑白、英文、没有任何出口。它不像这个站坏了，
 * 更像**走错了网站**。
 *
 * ─────────────────────────────────────────
 * 一个 404 页真正要做的事是「送人走」
 * ─────────────────────────────────────────
 *
 * 到这一页的人有两种：地址敲错了，和点了一条失效的旧链接。
 * 两种人都不需要道歉，需要的是下一步去哪 ——
 * 所以下面那几个口子比上面那句话重要。
 *
 * 不放「返回上一页」：来到 404 的人多半是**从外面点进来的**，
 * 上一页是微信或者别的站，退回去等于把人送出这个网站。
 *
 * ─────────────────────────────────────────
 * 这一页在根布局下，不带导航外壳
 * ─────────────────────────────────────────
 *
 * 外壳里的每一个入口都要判权限（群聊、后台、我的）。
 * 而 404 可能发生在任何路径上，包括访客访问的路径 ——
 * 在这里渲染一整套导航，等于把还没资格看到的入口摆出来。
 * 所以这一页自带出口，只放**所有人都能去**的那几个。
 */
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[26rem] flex-col justify-center px-6 py-12">
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
    </main>
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
