import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { describe, it } from "node:test";
import { stripComments as strip } from "./_source";

/**
 * 点一条通知，它就该已读。
 *
 * ─────────────────────────────────────────
 * 在这之前，点了不会已读
 * ─────────────────────────────────────────
 *
 * `markNotificationsRead(id)` 一直支持传单条 id，而**全站只有
 * 「全部已读」那个按钮调它**，而且不传 id。列表里每一条都是
 * 一个光秃秃的 `<Link>`：点进去、看完、回来，红点还在。
 *
 * 于是这一页只有两种状态 —— 全是红点，或者一键全灭。
 * 中间那个「我看过这条了」根本没有。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

describe("**每一条都要能单独点掉**", () => {
  it("列表用的是会标已读的行，不是裸 Link", () => {
    const page = src("app/(app)/notifications/page.tsx");
    assert.match(page, /<NotificationRow/);

    const row = strip(src("components/notifications/NotificationRow.tsx"));
    assert.match(row, /markNotificationsRead\(id\)/);
    assert.match(row, /onClick=\{mark\}/);
  });

  it("**不能给客户端组件传函数** —— 第一版用 children 渲染函数，整页 500", () => {
    /*
     * 调用方是服务端组件，函数过不了 RSC 那道边界：
     * 「Functions cannot be passed directly to Client Components」。
     * 生产日志里三个 digest 全是这一条。
     *
     * 这个边界上只能传数据 —— 图标因此传字符串，在客户端映射成组件。
     */
    const page = src("app/(app)/notifications/page.tsx");
    assert.doesNotMatch(page, /<NotificationRow[\s\S]{0,400}\{\(read\) =>/);
    assert.match(page, /type=\{item\.type\}/);
    assert.match(page, /timeLabel=\{relativeTime\(item\.updatedAt\)\}/);

    const row = src("components/notifications/NotificationRow.tsx");
    assert.doesNotMatch(row, /children: \(read: boolean\)/);
    assert.match(row, /const ICONS: Record<string, typeof Bell>/);
  });

  it("**没有链接的通知也点得掉** —— 否则那条红点永远消不掉", () => {
    /*
     * 「系统公告」这类没有落点。一条永远消不掉的未读，
     * 最后会让人把整个通知页当成噪音。
     */
    const row = src("components/notifications/NotificationRow.tsx");
    // 目标已被删掉的那些走同一条路 —— 都是「点得掉、但不假装点进去有东西」
    assert.match(row, /if \(!href \|\| targetGone\)/);
    assert.match(row, /<button type="button" onClick=\{mark\}/);
  });

  it("已读要**乐观更新** —— 点完就跳走，等服务端回来那页已经不在了", () => {
    const row = src("components/notifications/NotificationRow.tsx");
    assert.match(row, /useOptimistic/);
    // setRead 在 await 之前
    const fn = row.slice(row.indexOf("const mark ="));
    assert.ok(
      fn.indexOf("setRead(true)") < fn.indexOf("await markNotificationsRead"),
      "先等服务端再变灰",
    );
  });

  it("已读的不重复请求", () => {
    const row = strip(src("components/notifications/NotificationRow.tsx"));
    assert.match(row, /if \(read\) return;/);
  });
});

describe("**角标也要跟着掉**", () => {
  it("action 把新的未读数带回来", () => {
    /*
     * 角标有两个来源：AppShell 服务端渲染的初始值，和 SSE 推来的实时值。
     * 这个 action 两个都碰不到 —— revalidatePath("/notifications")
     * revalidate 不到布局里的角标，标记已读也不触发 SSE。
     *
     * 于是「点掉最后一条未读」之后红点还在，人会以为没点掉，再点一次。
     */
    const actions = strip(src("lib/forum/notify-actions.ts"));
    assert.match(actions, /unread: unreadCount\(user\.id\)/);
  });

  it("两个调用点都把数字写进小仓库", () => {
    for (const f of ["components/notifications/NotificationRow.tsx", "components/forum/MarkAllRead.tsx"]) {
      assert.match(src(f), /setLiveUnread\(result\.unread\)/, `${f} 没更新角标`);
    }
  });

  it("失败时不动角标 —— 未登录会返回 ok:false", () => {
    for (const f of ["components/notifications/NotificationRow.tsx", "components/forum/MarkAllRead.tsx"]) {
      assert.match(src(f), /if \(result\.ok\) setLiveUnread/, `${f} 没判 ok`);
    }
  });
});

describe("**没开推送时提一句，用不了的地方一个字都不提**", () => {
  /*
   * 这块提示以前是通知页上单独的一张 PushNudge，
   * 现在并进了首页那个统一的提示位（一次只出一个）——
   * 同一件事在两个地方各提一次，是让人厌烦最快的办法。
   *
   * 口径一个字没改，所以断言跟着搬到新组件上。
   */
  const nudge = src("components/home/HomeNudge.tsx");

  it("微信里不提 —— 那里 Web Push 根本没有，劝了也点不动", () => {
    assert.match(nudge, /MicroMessenger/);
    assert.match(strip(nudge), /!wechat/);
  });

  it("**iOS Safari 里说的是「先加到主屏」** —— 那才是那台设备唯一的路", () => {
    assert.match(nudge, /添加到主屏幕/);
    assert.match(strip(nudge), /iosNeedsInstall/);
  });

  it("**站点没配推送时一个字都不提** —— 那会是一个开不了的开关", () => {
    assert.match(strip(nudge), /pushConfigured && hasPushApi/);
  });
});

describe("**站点图标不能还是脚手架自带的**", () => {
  const app = (p: string) => new URL(`../src/app/${p}`, import.meta.url);
  const pub = (p: string) => new URL(`../public/${p}`, import.meta.url);

  it("favicon 换掉了", () => {
    /*
     * Next.js 脚手架自带的 favicon.ico 恰好是 25931 字节。
     * 它出现在浏览器标签、微信分享卡片、加到主屏之后的桌面上 ——
     * 每一处都在说「这个站还没做完」。
     */
    assert.notEqual(statSync(app("favicon.ico")).size, 25931, "还是脚手架那个");
  });

  it("几种用途的图标都在", () => {
    for (const f of ["favicon.ico", "icon.png", "apple-icon.png"]) {
      assert.ok(statSync(app(f)).size > 0, `缺 ${f}`);
    }
    for (const f of ["icon-192.png", "icon-512.png"]) {
      assert.ok(statSync(pub(f)).size > 0, `缺 ${f}`);
    }
  });

  it("**是脚本生成的** —— 手工导出几个尺寸迟早对不上", () => {
    const script = readFileSync(new URL("../scripts/make-icons.py", import.meta.url), "utf8");
    assert.match(script, /favicon\.ico/);
    assert.match(script, /apple-icon\.png/);
    // 颜色跟 globals.css 的 --accent 对齐
    assert.match(script, /ACCENT = \(13, 92, 71, 255\)/);
    assert.match(readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8"), /--accent: #0d5c47/);
  });

  it("脚手架自带的那几个 SVG 清掉了", () => {
    for (const f of ["next.svg", "vercel.svg", "globe.svg", "file.svg", "window.svg"]) {
      assert.throws(() => statSync(pub(f)), `${f} 还在`);
    }
  });
});

describe("**PWA manifest —— 这是 iPhone 能收推送的前提**", () => {
  const manifest = src("app/manifest.ts");

  it("存在，而且 display 是 standalone", () => {
    /*
     * iOS 的 Web Push 只对加到主屏的站点开放，而加到主屏要求有 manifest。
     * display 用 browser 的话 iOS 认为这只是个书签，仍然不给推送权限。
     */
    assert.match(manifest, /display: "standalone"/);
  });

  it("图标指向真的存在的文件", () => {
    for (const f of ["/icon-192.png", "/icon-512.png"]) {
      assert.ok(manifest.includes(f), `manifest 没写 ${f}`);
      assert.ok(statSync(new URL(`../public${f}`, import.meta.url)).size > 0, `${f} 不存在`);
    }
  });

  it("有 maskable —— 没有的话 Android 会自己裁一刀，多半切掉耳朵", () => {
    assert.match(manifest, /purpose: "maskable"/);
  });

  it("**主题色跟页面底色走，不跟品牌色走**", () => {
    /*
     * 原来这里钉的是品牌绿 `#0d5c47`（也就是 `--accent`）。
     * 站长报「回复按钮和底部栏重合时会出现一条非常诡异的绿色栏」——
     * 就是它：`theme_color` 涂的是**浏览器 chrome**，
     * 而 chrome 紧挨着的是页面底色（近白 / 近黑），不是品牌色。
     *
     * 品牌绿没有被削弱，它照旧是全站的 `--accent`；
     * 只是「贴着页面边缘的那一条」该和页面同色。
     */
    assert.match(manifest, /theme_color: CANVAS_COLOR\.light/);
  });
});
