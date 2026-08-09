import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  MAX_IMAGE_MESSAGES,
  attribution,
  canShareWindow,
  canSharePost,
  clampContent,
  shareText,
  trimForImage,
} from "@/lib/share/rules";

/**
 * 分享。
 *
 * ─────────────────────────────────────────
 * 链接和图片不是同一件事
 * ─────────────────────────────────────────
 *
 * 链接还能靠权限收口 —— 对方点进来没权限就看不到。
 * **图片不行**：生成的那一刻内容就离开了这个站。
 *
 * 但也不能装作能拦住 —— 成员本来就能截图。
 * 立场是「不去拦人能做的事，但不替他多泄露一分」。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

describe("**图片能不能生成**", () => {
  it("公开帖随便分享", () => {
    const v = canSharePost({ visibility: "public", status: "published", viewerCanSee: true });
    assert.equal(v.ok, true);
    if (!v.ok) return;
    assert.equal(v.redactGroupName, false, "公开帖不用标内部内容");
  });

  it("成员可见的帖能分享，但要标成内部内容", () => {
    const v = canSharePost({ visibility: "member", status: "published", viewerCanSee: true });
    assert.equal(v.ok, true);
    if (!v.ok) return;
    assert.equal(v.redactGroupName, true);
  });

  it("**私密内容不给生成图** —— 图跑出去连作者自己都控制不住", () => {
    const v = canSharePost({ visibility: "private", status: "published", viewerCanSee: true });
    assert.equal(v.ok, false);
    if (v.ok) return;
    assert.match(v.reason, /收不回来/);
  });

  it("草稿和已删除不给", () => {
    for (const status of ["draft", "deleted", "locked"]) {
      const v = canSharePost({ visibility: "public", status, viewerCanSee: true });
      assert.equal(v.ok, false, `${status} 竟然能生成分享图`);
    }
  });

  it("自己都看不到的帖，更不能生成图", () => {
    const v = canSharePost({ visibility: "public", status: "published", viewerCanSee: false });
    assert.equal(v.ok, false);
  });
});

describe("**群聊图上永远不出现群名**", () => {
  it("不管谁分享都要抹掉 —— 这不是可配置项", () => {
    /*
     * 「这条消息来自哪个群」比消息本身敏感得多：
     * 它同时泄露了群的存在、群的主题、以及分享者在那个群里。
     */
    const v = canShareWindow({ viewerIsMember: true });
    assert.equal(v.ok, true);
    if (!v.ok) return;
    assert.equal(v.redactGroupName, true);
  });

  it("不在群里的人不能生成", () => {
    assert.equal(canShareWindow({ viewerIsMember: false }).ok, false);
  });

  it("**路由里根本不去查群名** —— 查了不画的写法，下一个人很容易顺手画上去", () => {
    const route = src("app/api/share/window/[id]/card/route.tsx");
    assert.doesNotMatch(route, /from "@\/lib\/db\/schema"[\s\S]{0,200}groups/);
    assert.doesNotMatch(route, /groups\./, "路由里碰了 groups 表");
  });

  it("**没权限时返回 404 而不是 403** —— 403 等于确认了这个 id 存在", () => {
    /*
     * id 是可以枚举的 —— 403 会让这个路由变成一个
     * 「这个群里有没有聊过某段」的探测接口。
     */
    const route = src("app/api/share/window/[id]/card/route.tsx");
    // 从**调用处**切，不是从 import 那一行
    const guard = route.slice(route.indexOf("!assertGroupAccess("));
    assert.match(guard.slice(0, 200), /status: 404/);
    assert.doesNotMatch(guard.slice(0, 200), /status: 403/);
  });
});

describe("裁成图上放得下的样子", () => {
  const msg = (i: number) => ({ senderName: `甲${i}`, content: `第 ${i} 句`, ts: i });

  it("条数够少时原样保留", () => {
    const { shown, omitted } = trimForImage([msg(1), msg(2)]);
    assert.equal(shown.length, 2);
    assert.equal(omitted, 0);
  });

  it("**超了要从后往前取** —— 一段对话的结论通常在末尾", () => {
    /*
     * 截断了结论的分享图会让人看不懂在讲什么。
     */
    const all = Array.from({ length: MAX_IMAGE_MESSAGES + 5 }, (_, i) => msg(i));
    const { shown, omitted } = trimForImage(all);
    assert.equal(shown.length, MAX_IMAGE_MESSAGES);
    assert.equal(omitted, 5);
    assert.equal(shown[shown.length - 1].content, all[all.length - 1].content, "把结论截掉了");
  });

  it("省掉了多少要说出来 —— 不说的话人会以为对话就这么长", () => {
    const all = Array.from({ length: 30 }, (_, i) => msg(i));
    assert.equal(trimForImage(all).omitted, 30 - MAX_IMAGE_MESSAGES);
  });

  it("单条太长要截，并且把换行压平", () => {
    const out = clampContent("一二三四五\n六七八九十", 8);
    assert.ok(out.length <= 8);
    assert.doesNotMatch(out, /\n/);
  });

  it("刚好到长度不加省略号", () => {
    assert.equal(clampContent("一二三", 3), "一二三");
  });
});

describe("**分享文案里只放链接，不放正文**", () => {
  it("帖子：标题 + 摘要 + 链接", () => {
    /*
     * 这一条让分享变得安全:文案可以随便转，
     * 而真正的内容在链接后面，谁点进来都要过一遍权限。
     */
    const text = shareText({
      kind: "post",
      title: "怎么在群里发验证码",
      url: "https://agenticlab.sh/forum/p/abc",
      excerpt: "主通道改成群消息之后……",
    });
    assert.match(text, /怎么在群里发验证码/);
    assert.match(text, /https:\/\/agenticlab\.sh\/forum\/p\/abc/);
  });

  it("**群聊片段不给标题** —— 编出来的标题比内容传得更远、也更容易失真", () => {
    const text = shareText({
      kind: "window",
      title: "不该被用到",
      url: "https://agenticlab.sh/search",
    });
    assert.match(text, /一段群聊记录/);
    assert.doesNotMatch(text, /不该被用到/);
  });

  it("摘要要截短 —— 文案是拿去粘到聊天框里的，太长没人看", () => {
    const text = shareText({
      kind: "post",
      title: "标题",
      url: "https://x/y",
      excerpt: "长".repeat(200),
    });
    assert.ok(text.length < 200, `文案 ${text.length} 字太长了`);
  });

  it("带上站名，让人知道这是哪来的", () => {
    assert.match(shareText({ kind: "post", title: "t", url: "u" }), /Agentic Lab/);
  });
});

describe("图上那行出处", () => {
  it("内部内容要说清楚", () => {
    assert.match(attribution({ memberOnly: true }), /成员社区内部内容/);
  });

  it("公开内容只留站名", () => {
    assert.doesNotMatch(attribution({ memberOnly: false }), /内部/);
  });
});

describe("**生成即记审计** —— 图跑出去之后至少查得到是谁生成的", () => {
  it("两个路由都记", () => {
    for (const p of [
      "app/api/share/window/[id]/card/route.tsx",
      "app/api/share/post/[id]/card/route.tsx",
    ]) {
      assert.match(src(p), /audit\(/, `${p} 没记审计`);
    }
  });
});

describe("分享面板", () => {
  const sheet = src("components/share/ShareSheet.tsx");

  it("**剪贴板失败时不装作成功** —— 微信 webview 上这不是罕见情况", () => {
    /*
     * 人以为复制上了，粘出来是空的 ——
     * 那比一开始就说「复制不了」糟得多。
     */
    assert.match(sheet, /setFallback\(value\)/);
    assert.match(sheet, /长按全选/);
  });

  it("能力检测走 API 是否存在，不猜屏幕宽度", () => {
    /*
     * 桌面 Chrome 也有 navigator.share，而某些安卓浏览器没有。
     * 按屏幕宽度猜的话两边都会猜错。
     */
    assert.match(sheet, /typeof navigator\.share === "function"/);
    assert.doesNotMatch(sheet, /innerWidth/);
  });

  it("用户取消系统分享不当成错误", () => {
    assert.match(sheet, /用户取消也会抛/);
  });
});

describe("**悬浮面板不能被别的元素挡住**", () => {
  const anchored = src("components/ui/anchored.ts");

  it("传送到 body —— z-index 调多大都出不了祖先的层叠上下文", () => {
    /*
     * 站长报的:「论坛的更多菜单会被底下的回复挡住」。
     * 成因是 animate-rise 里的 transform 让 <article> 成了层叠上下文，
     * 而回复列表在 article 外面、DOM 顺序更靠后。
     */
    for (const p of ["components/forum/PostManageMenu.tsx", "components/share/ShareSheet.tsx"]) {
      assert.match(src(p), /createPortal\(/, `${p} 还在原地 absolute，迟早被挡住`);
      assert.match(src(p), /document\.body/);
    }
  });

  it("用视口坐标定位 —— 配合 fixed", () => {
    assert.match(anchored, /getBoundingClientRect\(\)/);
    assert.match(anchored, /position: fixed|fixed/);
  });

  it("**滚动和缩放时重算** —— 不重算的话按钮跑了而菜单停在原地", () => {
    assert.match(anchored, /addEventListener\("scroll", place, true\)/);
    assert.match(anchored, /addEventListener\("resize", place\)/);
  });

  it("**靠右边缘时不会被推出屏幕** —— 算出负数的话人只看到「点了没反应」", () => {
    assert.match(anchored, /Math\.max\(EDGE, Math\.min\(raw, window\.innerWidth - width - EDGE\)\)/);
  });

  it("窄屏走底部弹层 —— 贴着按钮弹出来多半会被手挡住", () => {
    assert.match(anchored, /MOBILE_MAX/);
    assert.match(anchored, /safe-area-inset-bottom/);
  });

  it("**这个 hook 只返回普通值，ref 由调用方持有**", () => {
    /*
     * 把 ref 一起返回在对象里，调用方在渲染期读那个对象
     * 就会被 React 编译器拦下 —— 而它拦得对。
     */
    assert.match(anchored, /return \{ narrow, position, mounted \};/);
  });
});

describe("**接线：写了的路由要真的有人调**", () => {
  /*
   * 这个项目反复出现的坑:写了一个东西、接进了类型系统，
   * 看起来一切就绪 —— 但没有任何地方调它。
   */
  it("群聊分享图被检索结果调到了", () => {
    const hits = src("components/search/SemanticHits.tsx");
    assert.match(hits, /\/api\/share\/window\/\$\{hit\.windowId\}\/card/);
    assert.match(hits, /<ShareSheet/);
  });

  it("帖子分享图被帖子页调到了", () => {
    const page = src("app/(app)/forum/p/[id]/page.tsx");
    assert.match(page, /\/api\/share\/post\/\$\{post\.id\}\/card/);
    assert.match(page, /<ShareSheet/);
  });

  it("**帖子页会先判断能不能分享** —— 草稿上不该出现分享按钮", () => {
    const page = src("app/(app)/forum/p/[id]/page.tsx");
    assert.match(page, /canSharePost\(/);
    assert.match(page, /shareVerdict\.ok && \(/);
  });
});
