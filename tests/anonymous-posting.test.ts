import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * 匿名发帖与回复。
 *
 * ─────────────────────────────────────────
 * 服务端一直收，界面一直没有入口
 * ─────────────────────────────────────────
 *
 * `createPost` 收 `anonymous`、校验 `board.allow_anonymous`、落库，
 * 查询层连头像和主页链接都抹掉了 —— 而**发帖框里没有这个勾**，
 * 后台也没法给任何版块打开 `allow_anonymous`。
 * 也就是说这一整套判定从上线到今天一次都没被执行过。
 *
 * ─────────────────────────────────────────
 * 匿名最容易从看不见的地方漏
 * ─────────────────────────────────────────
 *
 * 名字抹了、头像抹了、主页链接抹了，剩下一个**配色种子** ——
 * 而配色是 `authorId` 的稳定哈希。于是同一个人的两篇匿名帖
 * 是同一个颜色（互相串得起来），和他的实名帖也是同一个颜色。
 * 颜色不会引起任何人怀疑，这正是它危险的地方。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

describe("**发帖和回复走同一条判定**", () => {
  it("发帖校验版块允不允许", () => {
    assert.match(strip(src("lib/forum/actions.ts")), /input\.anonymous && !board\.allowAnonymous/);
  });

  it("**回复也要校验** —— 原来这条完全没有", () => {
    /*
     * 发帖那条走了 `board.allowAnonymous`，回复这条没走，
     * 于是不允许匿名的版块里照样能匿名回复。
     * 一个只在其中一条路上生效的规则，等于没有这条规则。
     */
    const body = strip(src("lib/forum/actions.ts"));
    const fn = body.slice(body.indexOf("export async function createReply"));
    assert.match(fn, /!board\.allowAnonymous/);
  });

  it("界面藏起来了，值也不许带上去", () => {
    // 控件不显示不代表 state 是 false —— 换过版块的人身上还留着上一个勾
    for (const file of ["components/forum/ComposeForm.tsx", "components/forum/ReplyForm.tsx"]) {
      assert.match(strip(src(file)), /\?\s*anonymous\s*:\s*false|: false/, file);
    }
  });
});

describe("**匿名的漏点在配色**", () => {
  it("有一个专门给匿名用的配色档", () => {
    assert.match(strip(src("components/Avatar.tsx")), /ANONYMOUS_PALETTE/);
  });

  it("**帖子、回复、列表三处都不再拿 authorId 当种子**", () => {
    for (const file of [
      "app/(app)/forum/p/[id]/page.tsx",
      "components/forum/PostList.tsx",
    ]) {
      const body = strip(src(file));
      assert.match(body, /ANONYMOUS_PALETTE/, `${file} 没用匿名配色`);
      // 不许再出现「无条件拿 authorId 当种子」的写法
      assert.equal(
        /wxId=\{(?:post|reply)\.authorId\}/.test(body),
        false,
        `${file} 还在无条件用 authorId 当配色种子`,
      );
    }
  });

  it("**回复也要把 anonymous 传出来** —— 不然页面判断不了", () => {
    assert.match(strip(src("lib/forum/queries.ts")), /anonymous: r\.anonymous/);
  });

  it("所有匿名内容长得一样才是对的 —— 「匿名」就是同一个身份", () => {
    assert.match(src("components/Avatar.tsx"), /同一个身份|一模一样/);
  });
});

describe("**必须说清楚匿名管到哪儿**", () => {
  /*
   * 不说的话，人会以为连管理员也查不到，然后照着一个不存在的保护
   * 去写东西 —— 那比不给匿名这个选项更糟。
   */
  it("发帖框里写明管理员查得到", () => {
    assert.match(src("components/forum/ComposeForm.tsx"), /管理员查得到/);
  });

  it("回复框里也写 —— 两处说法不一致的话，人会以为其中一处是特例", () => {
    assert.match(src("components/forum/ReplyForm.tsx"), /管理员/);
  });

  it("**后台开这个开关时也要说** —— 否则管理员会以为自己也查不到，该开的时候不敢开", () => {
    assert.match(src("components/admin/BoardEditor.tsx"), /匿名是对其他用户的/);
  });

  it("那句话不能用 markdown 的星号 —— JSX 里会渲染成字面星号", () => {
    /*
     * 先 strip 掉注释再切。这个仓库的注释里到处是 `**强调**`，
     * 不剥的话断言匹配到的是我自己写的注释 ——
     * 这个坑在这批结构性测试里已经踩过好几次了。
     */
    const body = strip(src("components/forum/ComposeForm.tsx"));
    const at = body.indexOf("匿名发布");
    assert.notEqual(at, -1);
    assert.equal(
      /\*\*[^*\n]+\*\*/.test(body.slice(at, at + 900)),
      false,
      "写了 markdown 粗体，会显示成星号",
    );
  });
});

describe("后台", () => {
  it("**版块编辑器终于能开这两个开关了**", () => {
    /*
     * 这两列在 schema 里躺了很久而后台改不了 —— 也就是说
     * `allow_anonymous` 永远是 false（匿名功能等于不存在），
     * `require_tags` 永远是 false。
     */
    const body = strip(src("components/admin/BoardEditor.tsx"));
    assert.match(body, /allowAnonymous/);
    assert.match(body, /requireTags/);
  });

  it("保存时真的写进去了", () => {
    const body = strip(src("lib/admin/board-actions.ts"));
    assert.match(body, /allowAnonymous: input\.allowAnonymous/);
    assert.match(body, /requireTags: input\.requireTags/);
  });

  it("**后台仍然看得到真作者**，并且标着「匿名发布」", () => {
    // 匿名是对其他用户的，不是对管理员的 —— 否则处理纠纷时连是谁发的都查不到
    assert.match(src("lib/admin/posts.ts"), /（匿名发布）/);
  });
});

describe("查询层抹得干净", () => {
  const body = strip(src("lib/forum/queries.ts"));

  for (const [what, re] of [
    ["名字", /authorName: post\.anonymous\s*\?\s*"匿名"/],
    ["头像", /authorAvatar: post\.anonymous \? null/],
    ["主页链接", /authorWxId: post\.anonymous \? null/],
  ] as const) {
    it(`${what}抹掉了`, () => assert.match(body, re));
  }

  it("编辑帖子时不许改匿名 —— 改一次就把作者暴露了", () => {
    const fn = body.slice(body.indexOf("export async function updatePost"));
    assert.equal(/anonymous/.test(fn.slice(0, 2000)), false);
  });
});
