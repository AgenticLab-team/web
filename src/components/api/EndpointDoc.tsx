import { ChevronDown, Lock } from "lucide-react";

import type { Endpoint } from "@/lib/api-tokens/catalog";

/**
 * 一条端点的文档。
 *
 * ─────────────────────────────────────────
 * 抽出来是因为它出现在两个地方
 * ─────────────────────────────────────────
 *
 * 「你现在调得动的」和「还差权限的」长得一模一样，只多一行
 * 「缺哪个 scope」。抄两份的话，以后给文档加一个字段
 * （比如请求体示例）只会加在其中一份上，而另一份没人会想起来。
 *
 * ═════════════════════════════════════════
 * 它从「一张卡」改成了「一行可展开的目录」
 * ═════════════════════════════════════════
 *
 * 原来每条端点都是一张摊开的卡：方法、路径、摘要、scope、注意事项，
 * 外加一段两三行的 curl。十二条端点铺下来，在手机上是**十屏**——
 * 而人来这一栏通常只想干一件事：找到某一条，看它怎么调。
 * 摊开的十二条让「找」变成了滑动比赛，站长说的「划很久」就是这里。
 *
 * 现在收成一行 44px 的目录：方法徽章 + 路径 + 一句摘要，
 * 十二条一屏看完；点开才给 curl 和注意事项。
 *
 * 用原生 `<details>` 而不是自己搓一个折叠：
 *   · 键盘（Enter/空格）、读屏（「展开/折叠」）、浏览器页内查找
 *     全部白送 —— 自己搓的话这三样都要重写一遍，而多半只会写第一样
 *   · 没有 JS，所以它在服务端组件里就能用，不必为一个折叠
 *     把整栏文档变成客户端组件
 */

/**
 * 方法徽章的颜色。
 *
 * GET 中性、POST 染成警示色 —— 这一栏里 POST 全是**会改变世界**的
 * （发帖、发消息、顶掉群公告）。扫一眼就能把「读」和「写」分开，
 * 比读完每一行的摘要快得多。
 */
/*
 * 读用中性色，写用警示色。
 *
 * 这一栏要回答的问题只有一个：**按下去会不会改东西**。
 * 每种方法各挑一个颜色的话，眼睛得先学一遍配色才读得懂它，
 * 而那一栏只有 44px 宽。所以写的那几种共用一个徽章。
 */
const WRITE_BADGE = {
  background: "color-mix(in srgb, var(--warning) 16%, transparent)",
  color: "var(--warning)",
} as const;

const METHOD_STYLE = {
  GET: { background: "var(--fill)", color: "var(--ink-secondary)" },
  POST: WRITE_BADGE,
  PATCH: WRITE_BADGE,
  /*
   * DELETE 也用警示色而不是危险红。
   *
   * 这一栏里 DELETE 的对象是令牌、会话、草稿、雷达关键词 ——
   * 都是可以再建一个的东西。把它染成和封禁同一个红，
   * 会让真正不可逆的那些失去分量。
   */
  DELETE: WRITE_BADGE,
} as const;

export function EndpointDoc({
  endpoint,
  missing,
}: {
  endpoint: Endpoint;
  /** 缺哪几个 scope。空的话就是能调 */
  missing?: readonly string[];
}) {
  const blocked = (missing?.length ?? 0) > 0;

  return (
    <details className="inset-row">
      {/*
        * list-none 去掉浏览器自带的那个三角 —— 它在 Safari 和
        * Chrome 上长得不一样，而右边那个 chevron 是我们自己画的。
        */}
      <summary className="flex cursor-pointer list-none items-center gap-2.5 px-4 py-3 transition-colors hover:bg-[var(--fill)]">
        <span
          className="t-caption2 w-11 shrink-0 rounded-[var(--radius-chip)] py-0.5 text-center font-semibold"
          style={METHOD_STYLE[endpoint.method]}
        >
          {endpoint.method}
        </span>

        <span className="min-w-0 flex-1">
          <code className="t-footnote block break-all font-medium">{endpoint.path}</code>
          <span className="t-caption mt-0.5 block text-[var(--ink-secondary)]">
            {endpoint.summary}
          </span>
        </span>

        {/*
          * 调不动的挂一把锁，而不是把整行调暗。
          *
          * 原来是整张卡 opacity: 0.62 —— 那让**正文也一起变淡**，
          * 于是这一条的摘要比别的难读，而它的内容并没有更不重要：
          * 人正是要读懂它才知道值不值得去要这个权限。
          */}
        {blocked && (
          <span className="shrink-0" style={{ color: "var(--warning)" }}>
            {/*
              * 锁本身 aria-hidden，名字交给旁边这个 sr-only ——
              * 把 aria-label 挂在 <svg> 上要配 role="img" 才可靠，
              * 而那一对属性很容易在下次改动时掉一半。
              */}
            <Lock className="h-3.5 w-3.5" strokeWidth={2.2} aria-hidden />
            <span className="sr-only">权限不足</span>
          </span>
        )}
        <ChevronDown
          className="h-4 w-4 shrink-0 text-[var(--ink-quaternary)] transition-transform [details[open]_&]:rotate-180"
          strokeWidth={2.2}
          aria-hidden
        />
      </summary>

      <div className="space-y-2 bg-[var(--surface-sunken)] px-4 py-3">
        {blocked ? (
          /*
           * 说清楚**缺哪一个**，不是笼统一句「权限不够」。
           *
           * 笼统的话，人会去重新建一把令牌 —— 而新的那把
           * 同样不会勾上他缺的那一项，因为他不知道缺的是哪一项。
           */
          <p className="t-footnote" style={{ color: "var(--warning)" }}>
            还差 <code className="font-medium">{missing!.join("、")}</code> ——
            回上面建一把令牌，勾上这项就能调。
          </p>
        ) : (
          endpoint.scopes.length > 0 && (
            <p className="t-caption text-[var(--ink-tertiary)]">
              需要权限：<code>{endpoint.scopes.join("、")}</code>
            </p>
          )
        )}

        {endpoint.note && (
          <p className="t-footnote leading-relaxed text-[var(--ink-secondary)]">{endpoint.note}</p>
        )}

        <pre className="t-caption2 overflow-x-auto rounded-[var(--radius-control)] bg-[var(--surface)] p-3 leading-relaxed text-[var(--ink-secondary)]">
          {endpoint.example}
        </pre>
      </div>
    </details>
  );
}
