import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { describe, it } from "node:test";

import { BOARD_GROUPS, FALLBACK_GROUP, groupBoards } from "@/lib/forum/board-groups";
import {
  charCountOf,
  isLongform,
  LONGFORM_CHARS,
  readingLabel,
  readingMinutes,
} from "@/lib/forum/longform";

import { readCode, srcRoot } from "./_source";

/**
 * 版块分组与「值得读的」。
 *
 * ═════════════════════════════════════════
 * 这一整套是数出来的
 * ═════════════════════════════════════════
 *
 * 上线头一批 93 篇帖子：77 篇挤在「综合讨论」，43 篇正文超两千字
 * 而平均只有 2.3 次浏览 —— 短帖是 8.2 次。43 篇长文里 33 篇
 * 出自同一个人，他每篇拿到两次浏览。
 *
 * 所以这里测的不是「分组能不能显示」，是**那几条不出错就没人发现的规则**。
 */

describe("版块分组", () => {
  it("**没登记的版块落进「其它」，不是消失**", () => {
    /*
     * 这是这套映射唯一真正危险的地方：站长在后台新建一个版块时
     * 不会想到来改 board-groups.ts。而漏掉的后果如果是「不显示」，
     * 那个版块会**从论坛首页彻底消失** —— 它还在、还能发帖、
     * 搜索还搜得到，就是首页上没有入口。那种坏法要好几天才有人发现。
     */
    const out = groupBoards([{ key: "articles" }, { key: "站长后来加的" }]);
    const others = out.find((s) => s.group.key === FALLBACK_GROUP.key);
    assert.ok(others, "没登记的版块被吞了");
    assert.deepEqual(others.boards, [{ key: "站长后来加的" }]);
  });

  it("**每个版块只出现一次** —— 登记进两个组是抄写错误，不是特性", () => {
    const seen = new Set<string>();
    for (const group of BOARD_GROUPS) {
      for (const key of group.boards) {
        assert.ok(!seen.has(key), `${key} 登记在两个组里`);
        seen.add(key);
      }
    }
  });

  it("空组不显示 —— 访客看不到「站务与沉淀」里的任何一个", () => {
    // 版块可能因为权限对这个人整组不可见，那时候不该留个空标题
    const out = groupBoards([{ key: "general" }]);
    assert.equal(
      out.every((s) => s.boards.length > 0),
      true,
    );
  });

  it("一个版块都没有时不炸，返回空", () => {
    assert.deepEqual(groupBoards([]), []);
  });

  it("**分组里登记的 key 都真的存在**", async () => {
    /*
     * 登记了一个拼错的 key，那一格就永远是空的 —— 而页面上
     * 只是少了一行，没有任何报错。
     */
    const seed = readCode("lib/forum/board-seeds.ts");
    const declared = [...seed.matchAll(/key:\s*"([a-z]+)"/g)].map((m) => m[1]);
    for (const group of BOARD_GROUPS) {
      for (const key of group.boards) {
        assert.ok(declared.includes(key), `分组里的 ${key} 在 seed-boards 里不存在`);
      }
    }
  });
});

describe("预留版块", () => {
  it("**预留的 key 不和已建的撞**", async () => {
    /*
     * 撞了的话 seedBoards 会安静地跳过 —— 那是最难查的一种
     * 「怎么没建上」：没有报错，只是那个版块一直不出现。
     */
    const { DEFAULT_BOARDS, RESERVED_BOARDS } = await import("@/lib/forum/board-seeds");
    const live = new Set(DEFAULT_BOARDS.map((b) => b.key));
    for (const r of RESERVED_BOARDS) {
      assert.ok(!live.has(r.key), `预留的 ${r.key} 和已建版块撞了`);
    }
  });

  it("**每一条都写清了「等到什么时候再开」**", async () => {
    /*
     * 「以后看情况」等于永远不开。这里要求那个条件是可以数的，
     * 否则预留就变成了一张没人会再看的许愿单。
     */
    const { RESERVED_BOARDS } = await import("@/lib/forum/board-seeds");
    assert.ok(RESERVED_BOARDS.length > 0);
    for (const r of RESERVED_BOARDS) {
      assert.ok(r.openWhen.length > 8, `${r.key} 的 openWhen 太空泛`);
    }
  });

  it("预留的**不会被建出来** —— 空版块比没有更糟", () => {
    /*
     * 一个挂在首页写着「0」的版块，第一个想发的人看见没人发过，
     * 于是也不发。seedBoards 只认 DEFAULT_BOARDS。
     */
    const code = readCode("lib/forum/seed-boards.ts");
    const seedFn = code.slice(code.indexOf("export function seedBoards"));
    assert.equal(seedFn.includes("RESERVED_BOARDS"), false, "seedBoards 不该碰预留清单");
  });
});

describe("长文的判定", () => {
  it("**按码点数，不是 .length**", () => {
    /*
     * `"🧠".length` 是 2。一篇 emoji 多的短帖会被算长一截，
     * 于是混进「值得读的」—— 而那正好是这套东西要挡的内容。
     */
    assert.equal(charCountOf("🧠🧠🧠"), 3);
    assert.equal("🧠🧠🧠".length, 6);
  });

  it("门槛落在真实分布的空档里", () => {
    // 现有帖子在 300 和 2000 之间几乎是空的，所以两边都不会误判
    assert.equal(isLongform(LONGFORM_CHARS), true);
    assert.equal(isLongform(LONGFORM_CHARS - 1), false);
  });

  it("**「0 分钟读完」不是一个说法**", () => {
    assert.equal(readingMinutes(0), 1);
    assert.equal(readingMinutes(5), 1);
  });

  it("超过一小时就不报分钟数 —— 「87 分钟」是假精度", () => {
    /*
     * 谁也不会正好读 87 分钟。那个数真正传达的是
     * 「这篇很长，你可能要分两次」—— 直接说更有用。
     */
    assert.equal(readingLabel(300 * 59), "59 分钟");
    assert.match(readingLabel(300 * 60), /一小时以上/);
    assert.match(readingLabel(300 * 500), /一小时以上/);
  });

  it("阅读速度偏慢 —— 说短了比说长了糟", () => {
    // 说「3 分钟」结果读了 15 分钟，下次他就不信这个数了
    assert.ok(readingMinutes(3000) >= 10, "3000 字不该被说成几分钟就读完");
  });
});

describe("「值得读的」这条路", () => {
  it("**它按内容形态取，不按版块取**", () => {
    /*
     * 做成版块的话，一篇讲部署的长文得在「折腾与教程」和这里之间
     * 选一个 —— 而它两边都属于。
     */
    const q = readCode("lib/forum/queries.ts");
    const clause = q.slice(q.indexOf("longformOnly"));
    // 不用 /s：它要 es2018，而部署那边的 tsc 会拒
    assert.match(clause, /featured[\s\S]*=[\s\S]*1[\s\S]*OR[\s\S]*length/);
  });

  it("**精华和长度是「或」，不是「且」**", () => {
    /*
     * 只认精华：这个位置永远只有站长手点过的那几篇（现在全站两篇）。
     * 只认长度：一篇长而水的帖子和一篇被认可的短文待遇一样。
     */
    const q = readCode("lib/forum/queries.ts");
    const clause = q.slice(q.indexOf("options.longformOnly"), q.indexOf("options.longformOnly") + 300);
    assert.match(clause, /OR/);
    assert.equal(/featured[^)]*AND[^)]*length/.test(clause), false);
  });

  it("**deep 的衰减按天，不按小时**", () => {
    /*
     * hot 的分母是「小时数 + 2」，一篇帖子一天之后基本就沉了。
     * 那对快讯是对的，对一篇讲架构的长文是错的 ——
     * 它半年后还成立，而写它花了一天。
     */
    const q = readCode("lib/forum/queries.ts");
    const deep = q.slice(q.indexOf("deep: ["), q.indexOf("deep: [") + 400);
    assert.match(deep, /86400000/, "deep 没有按天衰减");
    assert.equal(/3600000/.test(deep), false, "deep 不该用小时");
  });

  it("正文不跟着列表一路传到组件里", () => {
    /*
     * 最长那篇一万三千字，十五条一页就是二十万字穿过 RSC 边界，
     * 而屏幕上只会显示「45 分钟」。所以字数在查询层就算好。
     */
    const q = readCode("lib/forum/queries.ts");
    assert.match(q, /charCount:\s*charCountOf\(/);

    /*
     * 切到**接口自己的收尾大括号**，不是切到某个注释。
     *
     * 第一版用的是下一段注释当界标 —— 而 readCode 会把注释剥掉，
     * 于是 indexOf 返回 -1，slice 切出了整个文件，
     * 断言实际在对全文做检查（当场就红了，红得对但理由不对）。
     * 这个仓库里同一个坑踩过好几次了。
     */
    const from = q.indexOf("export interface PostSummary");
    const summary = q.slice(from, q.indexOf("\n}", from));
    assert.equal(/\bcontent\b\s*:/.test(summary), false, "PostSummary 不该带正文");
  });

  it("列表上只给长文标阅读时长", () => {
    /*
     * 每条都标的话，「1 分钟」会出现在九成的帖子上，
     * 于是它变成噪音，长文那条也跟着没人看见 ——
     * 而这个标记存在的全部意义正是让长文看起来不一样。
     */
    assert.match(readCode("components/forum/PostList.tsx"), /isLongform\(post\.charCount\)\s*&&/);
  });
});

describe("路由不打架", () => {
  it("**/forum 下的固定页名不能和版块 key 撞**", async () => {
    /*
     * `/forum/deep` 是静态路由，它会盖住 `[board]` ——
     * 于是一个 key 叫 deep 的版块永远打不开，而它在列表里
     * 看起来一切正常，点进去是另一页。
     */
    const dir = `${srcRoot()}/app/(app)/forum`;
    const statics = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("["))
      .map((e) => e.name);

    const { DEFAULT_BOARDS, RESERVED_BOARDS } = await import("@/lib/forum/board-seeds");
    for (const board of [...DEFAULT_BOARDS, ...RESERVED_BOARDS]) {
      assert.ok(
        !statics.includes(board.key),
        `版块 ${board.key} 会被 /forum/${board.key} 这个固定页盖住`,
      );
    }
  });
});
