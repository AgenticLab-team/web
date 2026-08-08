import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  checkBoardConfig,
  checkBoardDelete,
  checkBoardKey,
  checkTagMerge,
  postsAboveCap,
  postsToRelink,
  visibilityLabel,
  wouldCreateCycle,
  VISIBILITY_OPTIONS,
} from "@/lib/admin/board-rules";
import type { Visibility } from "@/lib/db/schema/forum";

/**
 * 版块与标签管理的判定。
 *
 * 改版块配置**也是对别人内容的操作**：可见性上限一收紧，
 * 已经发出去的帖子会当场从别人眼前消失，作者不知道为什么。
 * 所以这里的重点不是「能不能改」，是「改之前能不能算出影响面」。
 */

describe("版块标识", () => {
  it("正常的 key 通过", () => {
    assert.equal(checkBoardKey("qa").ok, true);
    assert.equal(checkBoardKey("show-case").ok, true);
    assert.equal(checkBoardKey("v2").ok, true);
  });

  it("**大写、中文、空格都不行** —— key 要进 URL", () => {
    assert.equal(checkBoardKey("QA").ok, false);
    assert.equal(checkBoardKey("问答").ok, false);
    assert.equal(checkBoardKey("show case").ok, false);
  });

  it("不能以连字符开头", () => {
    assert.equal(checkBoardKey("-qa").ok, false);
  });

  it("太短或太长都不行", () => {
    assert.equal(checkBoardKey("a").ok, false);
    assert.equal(checkBoardKey("a".repeat(40)).ok, false);
  });

  it("路径穿越字符进不来", () => {
    assert.equal(checkBoardKey("../etc").ok, false);
    assert.equal(checkBoardKey("a/b").ok, false);
  });
});

describe("版块配置", () => {
  const base = {
    key: "qa",
    name: "问答",
    defaultVisibility: "member" as Visibility,
    maxVisibility: "member" as Visibility,
    postMinLevel: 1,
  };

  it("正常配置通过", () => {
    assert.equal(checkBoardConfig(base).ok, true);
  });

  it("名字不能为空", () => {
    assert.equal(checkBoardConfig({ ...base, name: "  " }).ok, false);
  });

  it("**默认可见性不能比上限更宽松**", () => {
    // 配成这样每个新帖都会被静默降级：作者选了「公开」，
    // 发出来却是「仅成员」，而且没有任何提示
    const r = checkBoardConfig({
      ...base,
      defaultVisibility: "public",
      maxVisibility: "member",
    });
    assert.equal(r.ok, false);
    assert.match(r.error!, /降级/);
  });

  it("默认比上限更严是允许的", () => {
    assert.equal(
      checkBoardConfig({ ...base, defaultVisibility: "group", maxVisibility: "member" }).ok,
      true,
    );
  });

  it("等级门槛必须是非负整数", () => {
    assert.equal(checkBoardConfig({ ...base, postMinLevel: -1 }).ok, false);
    assert.equal(checkBoardConfig({ ...base, postMinLevel: 1.5 }).ok, false);
    assert.equal(checkBoardConfig({ ...base, postMinLevel: 0 }).ok, true);
  });
});

describe("收紧上限的影响面", () => {
  const posts = [
    { id: "p1", visibility: "public" as Visibility },
    { id: "p2", visibility: "member" as Visibility },
    { id: "p3", visibility: "group" as Visibility },
  ];

  it("**算得出哪些帖子会受影响**", () => {
    // 只给数字管理员只能凭想象，要给具体是哪几篇
    const affected = postsAboveCap(posts, "member");
    assert.deepEqual(affected.map((p) => p.id), ["p1"]);
  });

  it("放宽上限不影响任何已有帖子", () => {
    assert.equal(postsAboveCap(posts, "public").length, 0);
  });

  it("收得很紧时多数帖子都会被降", () => {
    assert.equal(postsAboveCap(posts, "private").length, 3);
  });

  it("刚好等于上限的不算受影响", () => {
    assert.equal(postsAboveCap([{ id: "p", visibility: "member" }], "member").length, 0);
  });
});

describe("版块层级不能成环", () => {
  //  a ← b ← c
  const parents = new Map<string, string | null>([
    ["a", null],
    ["b", "a"],
    ["c", "b"],
  ]);

  it("挂到不相关的父版块下没问题", () => {
    assert.equal(wouldCreateCycle("c", "a", parents), false);
  });

  it("**不能把自己挂到自己下面**", () => {
    assert.equal(wouldCreateCycle("a", "a", parents), true);
  });

  it("**不能把祖先挂到后代下面**", () => {
    // a 挂到 c 下面就成了 a→c→b→a，面包屑和递归查询会直接死循环
    assert.equal(wouldCreateCycle("a", "c", parents), true);
  });

  it("挂到顶层永远可以", () => {
    assert.equal(wouldCreateCycle("c", null, parents), false);
  });

  it("**数据本身已经有环时检查自己也要能停下来**", () => {
    const broken = new Map<string, string | null>([
      ["x", "y"],
      ["y", "x"],
    ]);
    assert.doesNotThrow(() => wouldCreateCycle("z", "x", broken));
    assert.equal(wouldCreateCycle("z", "x", broken), false);
  });
});

describe("删除版块", () => {
  const base = { postCount: 0, childCount: 0, moveTo: null as string | null, boardId: "b1" };

  it("空版块可以直接删", () => {
    assert.equal(checkBoardDelete(base).ok, true);
  });

  it("**里面还有帖子就必须指定搬去哪里**", () => {
    // 直接删掉会让帖子变成孤儿：查得到、打不开
    const r = checkBoardDelete({ ...base, postCount: 12 });
    assert.equal(r.ok, false);
    assert.match(r.error!, /12 篇/);
  });

  it("指定了目标就可以删", () => {
    assert.equal(checkBoardDelete({ ...base, postCount: 12, moveTo: "b2" }).ok, true);
  });

  it("不能搬到它自己", () => {
    assert.equal(checkBoardDelete({ ...base, postCount: 1, moveTo: "b1" }).ok, false);
  });

  it("有子版块时先处理子版块", () => {
    assert.equal(checkBoardDelete({ ...base, childCount: 2 }).ok, false);
  });
});

describe("合并标签", () => {
  it("正常合并通过", () => {
    assert.equal(checkTagMerge({ fromId: "a", toId: "b", fromLocked: false }).ok, true);
  });

  it("不能合并到它自己", () => {
    assert.equal(checkTagMerge({ fromId: "a", toId: "a", fromLocked: false }).ok, false);
  });

  it("锁定的标签不能被合并掉", () => {
    assert.equal(checkTagMerge({ fromId: "a", toId: "b", fromLocked: true }).ok, false);
  });
});

describe("合并时的关联去重", () => {
  it("只有源标签有的帖子直接改指向", () => {
    const { relink, dropDuplicate } = postsToRelink(["p1", "p2"], []);
    assert.deepEqual(relink, ["p1", "p2"]);
    assert.deepEqual(dropDuplicate, []);
  });

  it("**两个标签都有的帖子只留一条关联**", () => {
    // 不去重的话唯一索引直接报错、整次合并回滚 ——
    // 而「有帖子同时打了这两个标签」恰恰是最该合并的信号
    const { relink, dropDuplicate } = postsToRelink(["p1", "p2", "p3"], ["p2"]);
    assert.deepEqual(relink, ["p1", "p3"]);
    assert.deepEqual(dropDuplicate, ["p2"]);
  });

  it("完全重叠时全部丢弃，不会剩下任何冲突", () => {
    const { relink, dropDuplicate } = postsToRelink(["p1"], ["p1"]);
    assert.deepEqual(relink, []);
    assert.deepEqual(dropDuplicate, ["p1"]);
  });

  it("源标签没有帖子时什么都不做", () => {
    const { relink, dropDuplicate } = postsToRelink([], ["p1"]);
    assert.equal(relink.length + dropDuplicate.length, 0);
  });
});

describe("可见性文案", () => {
  it("六个级别都有中文名", () => {
    assert.equal(VISIBILITY_OPTIONS.length, 6);
    for (const option of VISIBILITY_OPTIONS) {
      assert.ok(option.label && option.label !== option.key, `${option.key} 没有中文名`);
    }
  });

  it("未知值原样返回", () => {
    assert.equal(visibilityLabel("brand_new"), "brand_new");
  });
});
