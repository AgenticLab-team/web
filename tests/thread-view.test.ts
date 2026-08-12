import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  MAX_DEPTH,
  arrange,
  buildFlat,
  buildThread,
  parseViewMode,
  threadingIsMeaningful,
} from "@/lib/forum/thread-rules";
import { stripComments as strip, forumWritePath } from "./_source";

/**
 * 楼中楼（树形视图）。
 *
 * ─────────────────────────────────────────
 * 先量了一下：28 条回复，0 次引用
 * ─────────────────────────────────────────
 *
 * `replies.parent_id` 零引用，`quoted_reply_id` 也一行数据都没有。
 * 树是空的 —— 而原因不是没人想回复某一楼，是那个动作在界面上
 * **几乎不存在**：一个没有文字、用最淡墨色画的引号图标。
 *
 * 所以这件事得倒过来做：先让「回复这一楼」看得见，树才有东西可长。
 * 只做视图的话就是又一个死开关 —— 一棵永远只有一层的树，
 * 和平铺看起来一模一样。
 *
 * ─────────────────────────────────────────
 * 这一组测试大半在测「不能弄丢任何一条」
 * ─────────────────────────────────────────
 *
 * 树形是最容易把内容显示丢的一种排版：父级被删、层级过深、
 * 数据里有环 —— 每一种都能让某条回复静悄悄地不出现，
 * 而写它的人会以为自己被删了。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

const r = (id: string, floor: number, parentId: string | null = null) => ({ id, floor, parentId });

/** 1 ← 2, 1 ← 4, 2 ← 3, 5 独立 */
const SAMPLE = [
  r("a", 1),
  r("b", 2, "a"),
  r("c", 3, "b"),
  r("d", 4, "a"),
  r("e", 5),
];

const floorsOf = (nodes: { reply: { floor: number } }[]) => nodes.map((n) => n.reply.floor);

describe("排列顺序", () => {
  it("平铺就是楼层顺序", () => {
    assert.deepEqual(floorsOf(buildFlat(SAMPLE)), [1, 2, 3, 4, 5]);
  });

  it("树形按「谁接着谁」排", () => {
    // 1 → (2 → 3) → 4，然后独立的 5
    assert.deepEqual(floorsOf(buildThread(SAMPLE)), [1, 2, 3, 4, 5]);
  });

  it("**同一层按楼层升序** —— 楼层就是时间顺序，读起来才是对话的样子", () => {
    const out = buildThread([r("a", 1), r("late", 9, "a"), r("early", 3, "a")]);
    assert.deepEqual(floorsOf(out), [1, 3, 9]);
  });

  it("后发的顶层帖排在后面", () => {
    const out = buildThread([r("z", 9), r("a", 1), r("m", 5, "a")]);
    assert.deepEqual(floorsOf(out), [1, 5, 9]);
  });

  it("深度对得上", () => {
    const byFloor = new Map(buildThread(SAMPLE).map((n) => [n.reply.floor, n.depth]));
    assert.deepEqual([...byFloor.entries()], [[1, 0], [2, 1], [3, 2], [4, 1], [5, 0]]);
  });
});

describe("**一条都不能丢**", () => {
  it("父级不在这一批里 —— 提到顶层，并且标出来", () => {
    /*
     * 父级被删了 / 被折叠滤掉了。不标的话，一条明明在回答别人的话
     * 会突然以顶层身份出现，读起来像在自言自语。
     */
    const out = buildThread([r("a", 1), r("orphan", 2, "gone")]);
    assert.equal(out.length, 2);
    const orphan = out.find((n) => n.reply.id === "orphan")!;
    assert.equal(orphan.depth, 0);
    assert.equal(orphan.orphaned, true);
  });

  it("正常的那些不会被误标成孤儿", () => {
    assert.equal(buildThread(SAMPLE).every((n) => !n.orphaned), true);
  });

  it("**数据里有环也不会死循环，而且一条不少**", () => {
    /*
     * 正常路径上造不出环（父级一定是更早的楼层），
     * 但坏数据不该让整页渲染不出来 —— 那是最糟的失败方式。
     */
    const cyclic = [r("a", 1, "b"), r("b", 2, "a")];
    const out = buildThread(cyclic);
    assert.equal(out.length, 2, "环把回复吃掉了");
  });

  it("空列表不炸", () => {
    assert.deepEqual(buildThread([]), []);
    assert.deepEqual(buildFlat([]), []);
  });

  it("一百条深链不丢也不炸", () => {
    const deep = Array.from({ length: 100 }, (_, i) =>
      r(`n${i}`, i + 1, i === 0 ? null : `n${i - 1}`),
    );
    const out = buildThread(deep);
    assert.equal(out.length, 100);
    assert.deepEqual(floorsOf(out), deep.map((x) => x.floor));
  });
});

describe("**缩进封顶，但内容不封顶**", () => {
  it("超过上限之后不再往里缩", () => {
    /*
     * 每层缩进约 16px。手机上缩到第六层时，
     * 留给文字的宽度只剩不到一半 —— 一句话被切成七行。
     */
    const deep = Array.from({ length: 8 }, (_, i) =>
      r(`n${i}`, i + 1, i === 0 ? null : `n${i - 1}`),
    );
    const out = buildThread(deep);
    assert.equal(Math.max(...out.map((n) => n.indent)), MAX_DEPTH);
  });

  it("**真实层级仍然保留** —— 界面靠它决定要不要加一行说明", () => {
    const deep = Array.from({ length: 8 }, (_, i) =>
      r(`n${i}`, i + 1, i === 0 ? null : `n${i - 1}`),
    );
    assert.equal(Math.max(...buildThread(deep).map((n) => n.depth)), 7);
  });

  it("**深的那些照样显示** —— 封遍历的话它们会在第四层凭空消失", () => {
    const deep = Array.from({ length: 8 }, (_, i) =>
      r(`n${i}`, i + 1, i === 0 ? null : `n${i - 1}`),
    );
    assert.equal(buildThread(deep).length, 8);
  });

  it("上限定在手机放得下的量级", () => {
    assert.ok(MAX_DEPTH >= 2 && MAX_DEPTH <= 5);
  });
});

describe("这一支还有多少条", () => {
  it("直接子节点和总后代分开算", () => {
    const byId = new Map(buildThread(SAMPLE).map((n) => [n.reply.id, n]));
    // a 下面直接挂着 b、d 两条，加上 b 底下的 c 共三条
    assert.equal(byId.get("a")!.childCount, 2);
    assert.equal(byId.get("a")!.descendantCount, 3);
    assert.equal(byId.get("b")!.descendantCount, 1);
    assert.equal(byId.get("e")!.descendantCount, 0);
  });

  it("平铺视图里不算这个 —— 那一栏在平铺下没有意义", () => {
    assert.equal(buildFlat(SAMPLE).every((n) => n.descendantCount === 0), true);
  });
});

describe("**没有嵌套时不给切换按钮**", () => {
  it("全是顶层 —— 两种视图长得一模一样", () => {
    /*
     * 摆一个点了什么都不变的按钮，人第一反应是这个站坏了，
     * 第二反应是不再点这个站的任何按钮。
     */
    assert.equal(threadingIsMeaningful([r("a", 1), r("b", 2)]), false);
  });

  it("有一条接着别人就算有意义", () => {
    assert.equal(threadingIsMeaningful([r("a", 1), r("b", 2, "a")]), true);
  });

  it("**父级不在这一批里不算** —— 那条会被提到顶层，还是一层", () => {
    assert.equal(threadingIsMeaningful([r("a", 1), r("b", 2, "不存在")]), false);
  });
});

describe("视图参数", () => {
  it("认得 flat / threaded", () => {
    assert.equal(parseViewMode("flat", "threaded"), "flat");
    assert.equal(parseViewMode("threaded", "flat"), "threaded");
  });

  it("乱填的回退到默认，不报错", () => {
    assert.equal(parseViewMode("tree", "flat"), "flat");
    assert.equal(parseViewMode(undefined, "threaded"), "threaded");
    assert.equal(parseViewMode("", "flat"), "flat");
  });

  it("arrange 按模式分派", () => {
    assert.deepEqual(floorsOf(arrange(SAMPLE, "flat")), [1, 2, 3, 4, 5]);
    assert.equal(arrange(SAMPLE, "threaded").some((n) => n.depth > 0), true);
  });
});

describe("**楼层号不跟着树变**", () => {
  it("两种视图里同一条的楼层号一样", () => {
    /*
     * #12 是这个页面唯一能拿去引用、能贴进群里的坐标。
     * 按树的顺序重新编号，等于让所有已经发出去的 #12 全部指错。
     */
    const flat = new Map(buildFlat(SAMPLE).map((n) => [n.reply.id, n.reply.floor]));
    const tree = new Map(buildThread(SAMPLE).map((n) => [n.reply.id, n.reply.floor]));
    assert.deepEqual([...flat.entries()].sort(), [...tree.entries()].sort());
  });
});

describe("接线", () => {
  it("**回复某一楼会写 parent_id** —— 这一列原来零引用", () => {
    const actions = strip(forumWritePath());
    assert.match(actions, /parentId = quoted\.id;/);
    assert.match(actions, /parentId,/);
  });

  it("跨帖引用被滤掉时 parentId 是 null，那条就是顶层", () => {
    const actions = strip(forumWritePath());
    assert.match(actions, /quotedReplyId: parentId \? input\.quotedReplyId : null/);
  });

  it("查询层把 parentId 带出来", () => {
    assert.match(src("lib/forum/queries.ts"), /parentId: r\.parentId,/);
  });

  it("**「回复」按钮有文字了** —— 原来只有一个最淡墨色的引号图标", () => {
    /*
     * 28 条回复 0 次引用，就是这么来的：没人知道它是干什么的，
     * 多半根本没注意到它在那儿。
     */
    // strip 掉注释再看 —— 上面那段注释里就写着 --ink-quaternary，
    // 不去掉的话这一条会去和注释比对
    const btn = strip(src("components/forum/QuoteButton.tsx"));
    assert.match(btn, /<span className="t-caption font-medium">回复<\/span>/);
    assert.doesNotMatch(btn, /ink-quaternary/, "按钮还是最淡的那档墨色");
  });

  it("措辞统一成「回复」，不写「引用」", () => {
    /*
     * 「引用」说的是机制（把那段话摘过来），「回复」说的是意图。
     * 人想做的是后者，而且只认后者。
     */
    for (const f of [
      "components/forum/QuoteButton.tsx",
      "components/forum/ReplyRow.tsx",
      "components/forum/ReplyForm.tsx",
    ]) {
      assert.doesNotMatch(strip(src(f)), /"引用"|引用 #\{/, `${f} 还写着「引用」`);
    }
  });

  it("版块的默认视图接上了 —— view_mode 原来只有种子数据写过", () => {
    const page = src("app/(app)/forum/p/[id]/page.tsx");
    assert.match(page, /parseViewMode\(/);
    assert.match(page, /\.viewMode/);
  });

  it("视图写在地址里 —— 那条链接分享出去对方看到的才一样", () => {
    assert.match(src("components/forum/ThreadToggle.tsx"), /\?view=\$\{mode\}/);
  });

  it("规则层不碰数据库", () => {
    const code = src("lib/forum/thread-rules.ts");
    for (const forbidden of ["server-only", "@/lib/db", "drizzle-orm"]) {
      assert.equal(code.includes(forbidden), false, `规则层引了 ${forbidden}`);
    }
  });
});
