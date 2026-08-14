import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { stripComments as strip } from "./_source";

/**
 * 头像和昵称要能点进主页；菜单要点得动；滚动条别一直挂着。
 *
 * ─────────────────────────────────────────
 * 之前几乎哪儿都点不动
 * ─────────────────────────────────────────
 *
 * 成员目录整页的人都不可点 —— 一本点不开的通讯录。
 * 榜单、搜索结果、帖子里的作者也一样：头像和昵称就在那儿，
 * 看起来像能点，点下去什么都不发生。
 * 只有群聊存档给昵称加了链接，而它旁边的头像没有 ——
 * 同一个人，两种行为。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

describe("**匿名不能被点穿**", () => {
  it("匿名帖 / 匿名回复的 authorWxId 是 null", () => {
    /*
     * 点进去就是本人，那等于没有匿名。
     * 头像已经这么处理了（anonymous ? null : ...），链接必须跟上。
     */
    const q = strip(src("lib/forum/queries.ts"));
    assert.match(q, /authorWxId: post\.anonymous \? null :/);
    assert.match(q, /authorWxId: r\.anonymous \? null :/);
  });

  it("PersonLink 拿到 null 就退化成普通 span，长得一样只是不能点", () => {
    /*
     * 不做灰化 —— 那会让「这个人比较特殊」的错觉出现在一整页人身上。
     */
    const c = src("components/PersonLink.tsx");
    assert.match(c, /if \(!target\) return <span className=\{className\}>\{children\}<\/span>;/);
  });

  it("没绑微信的人也不给链接 —— 主页按微信 ID 定位，那会是个必然 404", () => {
    const c = src("components/PersonLink.tsx");
    assert.match(c, /wxId\?: string \| null/);
  });

  it("只包着头像的链接要有 aria-label —— 读屏否则念不出来是谁", () => {
    assert.match(src("components/PersonLink.tsx"), /aria-label=\{`\$\{name\} 的主页`\}/);
  });
});

describe("接线", () => {
  const surfaces: [string, string][] = [
    ["成员目录", "app/(app)/members/page.tsx"],
    ["榜单", "components/LeaderboardList.tsx"],
    // 存档那一行后来抽成了组件（一条消息要压进一行，排版细节太多）——
    // 断言跟着渲染那一行的文件走，页面本身只负责取数和拼链接
    ["群聊存档", "components/messages/ArchiveMessage.tsx"],
    ["搜索结果", "components/search/MessageHitList.tsx"],
    ["帖子详情", "app/(app)/forum/p/[id]/page.tsx"],
  ];

  for (const [label, file] of surfaces) {
    it(`${label}接上了`, () => {
      assert.match(src(file), /<PersonLink/, `${label} 没接`);
    });
  }

  it("**成员目录仍然不吐 wx_id** —— 它链的是账号 id 那条中转", () => {
    /*
     * 目录里列的是所有同群的人，**包括从没在群里说过话的**。
     * 他们的 wx_id 在别处拿不到（存档里只有开过口的人），
     * 而拿着 wx_id 就能在微信里直接加人 ——
     * 一次「让头像可以点」不该顺带把一群沉默的人的微信号
     * 摊在页面源码里。tests/member-directory.test.ts ④ 守的就是这条。
     */
    const q = src("lib/members/queries.ts");
    assert.match(q, /hasProfile: boolean;/);
    assert.doesNotMatch(q, /^\s*wxId: string \| null;$/m);

    const page = src("app/(app)/members/page.tsx");
    assert.match(page, /`\/members\/by\/\$\{member\.id\}`/);
  });

  it("中转那一页要登录，而且查不到和没绑微信一律 404", () => {
    /*
     * 门槛不能比主页低。两种失败也不区分 ——
     * 区分了就等于回答「这个账号 id 存在吗」。
     */
    const route = strip(src("app/members/by/[userId]/page.tsx"));
    assert.match(route, /getCurrentUser\(\)/);
    assert.match(route, /if \(!me\) notFound\(\)/);
    assert.match(route, /if \(!row\?\.wxId\) notFound\(\)/);
  });

  it("**目录里指向自己的那一行不给链接**", () => {
    assert.match(src("app/(app)/members/page.tsx"), /if \(member\.isMe \|\| !member\.hasProfile\) return null;/);
  });

  it("**搜索结果的头像挪到了按钮外面** —— <button> 里不能放 <a>", () => {
    /*
     * 嵌进去在部分浏览器上直接失效，键盘遍历顺序也会乱。
     */
    // strip 掉注释再找 —— 上面那段注释里就写着「<button> 里不能放 <a>」，
    // 不去掉的话这一条会去和注释比顺序
    const c = strip(src("components/search/MessageHitList.tsx"));
    const personAt = c.indexOf("<PersonLink");
    const buttonAt = c.indexOf("<button");
    assert.ok(personAt > 0 && buttonAt > 0 && personAt < buttonAt, "PersonLink 还在 button 里面");
  });

  it("**论坛列表整行是个链接，所以不套第二层** —— 嵌套 <a> 是坏的 HTML", () => {
    const list = src("components/forum/PostList.tsx");
    assert.doesNotMatch(list, /<PersonLink/);
  });
});

describe("**菜单点了就消失**（传送门把「里面」和「外面」拆开了）", () => {
  it("关闭判定要同时看面板的 ref", () => {
    /*
     * 面板为了不被后面的回复盖住，是 createPortal 到 document.body 的。
     * 这么一来它在 DOM 上不再是触发按钮的后代 ——
     * 只判根元素 contains 的话，点面板里任何一项都算「点在外面」，
     * 菜单在手指落下那一刻就关了。
     *
     * 传送门是上一次修 bug 引进来的，而这个判定留在原地没跟着改。
     */
    const menu = src("components/forum/PostManageMenu.tsx");
    assert.match(menu, /useDismissOnOutside\(open, close, \[rootRef, panelRef\]\)/);
    // 旧的那段单 ref 判定不能再有
    assert.doesNotMatch(strip(menu), /!rootRef\.current\.contains/);
  });

  it("helper 收在 anchored.ts 里 —— 两个 ref 本来就在那儿", () => {
    const a = src("components/ui/anchored.ts");
    assert.match(a, /export function useDismissOnOutside/);
    assert.match(a, /latest\.current\.some\(\(r\) => r\.current\?\.contains\(target\)\)/);
  });

  it("Escape 也能关", () => {
    assert.match(src("components/ui/anchored.ts"), /e\.key === "Escape"/);
  });
});

describe("**滚动条不该一直挂在那儿**", () => {
  const css = src("app/globals.css");

  it("桌面端默认透明，鼠标进来才淡入", () => {
    /*
     * 一直显示的问题不是难看，是它在说谎：一条常驻的滚动条会被读成
     * 「这里有更多内容」，而侧栏和那几排药丸大多数时候根本没有溢出。
     */
    assert.match(css, /::-webkit-scrollbar-thumb \{\s*background: transparent;/);
    assert.match(css, /:hover::-webkit-scrollbar-thumb/);
  });

  it("轨道宽度照留 —— 收进去会让内容在鼠标移入时横向跳一下", () => {
    assert.match(css, /::-webkit-scrollbar \{ width: 10px; height: 10px; \}/);
  });

  it("键盘用户用 focus-within 也唤得出来", () => {
    assert.match(css, /:focus-within::-webkit-scrollbar-thumb/);
  });

  it("**横着滑的药丸排一条线都不画**", () => {
    /*
     * 那种行高只有 30 来像素，底下压一条 10px 的横条，
     * 视觉上就成了一条跟内容无关的下划线。
     */
    assert.match(css, /\.no-scrollbar \{/);
    assert.match(css, /\.no-scrollbar::-webkit-scrollbar \{/);
    // 这里只该管「有没有用上 no-scrollbar」；纵向留白归 ui-consistency 那条管
    assert.match(src("components/ui/primitives.tsx"), /"no-scrollbar -mx-4 /);
  });

  it("手写的那几排药丸也用上了同一个类", () => {
    for (const f of ["components/forum/ComposeForm.tsx", "components/admin/MatrixEditor.tsx"]) {
      assert.match(src(f), /no-scrollbar -mx-4/, `${f} 还带着滚动条`);
    }
  });
});

describe("**资源库上面原来堆了三行壳子**", () => {
  it("排序和筛选合成一行", () => {
    /*
     * 搜索框 + 两排药丸 = 三行。在手机上，翻到第一条链接之前
     * 得先划过半屏的按钮。两组做的是同一件事（把列表收窄）。
     */
    const page = src("app/(app)/links/page.tsx");
    assert.equal((page.match(/<PillRow/g) ?? []).length, 1, "还是两排");
  });

  it("中间那道竖线不念给读屏", () => {
    assert.match(src("app/(app)/links/page.tsx"), /w-px self-center bg-\[var\(--separator\)\]\}?[\s\S]{0,40}aria-hidden/);
  });

  it("「最有用」还在，而且仍排在前面 —— 它是这一页真正的价值", () => {
    const page = src("app/(app)/links/page.tsx");
    assert.ok(page.indexOf("最有用") < page.indexOf("我收藏的"));
  });
});
