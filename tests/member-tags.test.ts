import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FACET_MIN_HOLDERS,
  MAX_TAGS_PER_USER,
  MAX_TAG_LENGTH,
  matchesQuery,
  parseTags,
  preferredLabel,
  tagLabel,
  tagSlug,
  visibleFacets,
} from "@/lib/members/tags";

describe("归一化 —— 标签目录唯一的失败方式是碎掉", () => {
  it("**大小写不同的是同一个标签**", () => {
    assert.equal(tagSlug("RAG"), tagSlug("rag"));
    assert.equal(tagSlug("Rag"), tagSlug("rAG"));
  });

  it("空格位置不同的是同一个标签", () => {
    assert.equal(tagSlug(" 大模型 "), tagSlug("大模型"));
    assert.equal(tagSlug("大 模 型"), tagSlug("大模型"));
    assert.equal(tagSlug("prompt engineering"), tagSlug("PromptEngineering"));
  });

  it("全角字符和半角是同一个 —— 输入法带出来的差别不该分裂标签", () => {
    assert.equal(tagSlug("ＲＡＧ"), tagSlug("RAG"));
    assert.equal(tagSlug("Ａgent"), tagSlug("agent"));
  });

  it("分隔符不同的是同一个", () => {
    assert.equal(tagSlug("前端/React"), tagSlug("前端 React"));
    assert.equal(tagSlug("A-B"), tagSlug("A_B"));
    assert.equal(tagSlug("多模态·大模型"), tagSlug("多模态大模型"));
  });

  it("显示形态保留大小写，只收空白", () => {
    assert.equal(tagLabel("  RAG  "), "RAG");
    assert.equal(tagLabel("Prompt   工程"), "Prompt 工程");
    assert.notEqual(tagLabel("RAG"), tagLabel("rag"));
  });

  it("纯符号归一化后是空 —— 不构成一个标签", () => {
    assert.equal(tagSlug("///"), "");
    assert.equal(tagSlug("  "), "");
    assert.equal(tagSlug("-·-"), "");
  });

  it("归一化是幂等的", () => {
    for (const raw of ["RAG", " 大 模型 ", "前端/React", "Ａgent"]) {
      assert.equal(tagSlug(tagSlug(raw)), tagSlug(raw), raw);
    }
  });
});

describe("解析提交 —— 不静默丢弃", () => {
  it("逗号、顿号、分号、换行都当分隔符", () => {
    for (const sep of [",", "，", ";", "；", "\n"]) {
      const { tags } = parseTags(`RAG${sep}Agent`);
      assert.equal(tags.length, 2, `分隔符 ${JSON.stringify(sep)} 没生效`);
    }
  });

  it("数组形式也吃", () => {
    assert.equal(parseTags(["RAG", "Agent"]).tags.length, 2);
  });

  it("空项跳过但不报错", () => {
    const { tags, issues } = parseTags("RAG,,,  ,Agent");
    assert.equal(tags.length, 2);
    assert.equal(issues.length, 0);
  });

  it("**归一化后重复的会说一声**，不是悄悄少一个", () => {
    const { tags, issues } = parseTags("RAG, rag, ＲＡＧ");
    assert.equal(tags.length, 1);
    assert.equal(issues.length, 2);
    assert.ok(issues.every((i) => i.reason.includes("重复")));
  });

  it("超长的报出来，而不是截断成半截词", () => {
    const long = "一".repeat(MAX_TAG_LENGTH + 1);
    const { tags, issues } = parseTags(long);
    assert.equal(tags.length, 0);
    assert.match(issues[0].reason, new RegExp(String(MAX_TAG_LENGTH)));
  });

  it("刚好到上限的长度是允许的", () => {
    assert.equal(parseTags("一".repeat(MAX_TAG_LENGTH)).tags.length, 1);
  });

  it("超过数量上限的逐个报出来 —— 用户要知道是哪几个没存上", () => {
    const many = Array.from({ length: MAX_TAGS_PER_USER + 3 }, (_, i) => `tag${i}`);
    const { tags, issues } = parseTags(many);
    assert.equal(tags.length, MAX_TAGS_PER_USER);
    assert.equal(issues.length, 3);
    assert.deepEqual(issues.map((i) => i.input), ["tag8", "tag9", "tag10"]);
  });

  it("只有符号的报「不构成一个标签」", () => {
    const { tags, issues } = parseTags("///");
    assert.equal(tags.length, 0);
    assert.match(issues[0].reason, /符号/);
  });

  it("保留用户写下的形态，匹配用归一化的键", () => {
    const { tags } = parseTags("Prompt 工程");
    assert.equal(tags[0].label, "Prompt 工程");
    assert.equal(tags[0].slug, "prompt工程");
  });

  it("顺序按用户填的来 —— 排序是他表达重点的方式", () => {
    const { tags } = parseTags(["最重要", "其次", "最后"]);
    assert.deepEqual(tags.map((t) => t.label), ["最重要", "其次", "最后"]);
  });
});

describe("筛选栏 —— 只有一个人的标签是噪音", () => {
  const facets = [
    { slug: "rag", label: "RAG", count: 5 },
    { slug: "agent", label: "Agent", count: 2 },
    { slug: "solo", label: "只有我会", count: 1 },
  ];

  it("少于两个人的不进筛选栏", () => {
    const visible = visibleFacets(facets);
    assert.deepEqual(visible.map((f) => f.slug), ["rag", "agent"]);
    assert.equal(FACET_MIN_HOLDERS, 2);
  });

  it("按人数从多到少排", () => {
    assert.deepEqual(visibleFacets(facets).map((f) => f.count), [5, 2]);
  });

  it("人数相同时按 slug 排，保证顺序稳定不跳来跳去", () => {
    const tied = [
      { slug: "zeta", label: "Z", count: 3 },
      { slug: "alpha", label: "A", count: 3 },
    ];
    assert.deepEqual(visibleFacets(tied).map((f) => f.slug), ["alpha", "zeta"]);
  });

  it("门槛可调 —— 人少的时候可以放宽", () => {
    assert.equal(visibleFacets(facets, 1).length, 3);
  });
});

describe("同一个标签的显示形态", () => {
  it("**取用得最多的那个写法**，不是第一个人的写法", () => {
    const label = preferredLabel([
      { label: "rag", count: 1 },
      { label: "RAG", count: 9 },
    ]);
    assert.equal(label, "RAG", "第一个填小写的人把后面九个人都带成了小写");
  });

  it("只有一种写法时就用它", () => {
    assert.equal(preferredLabel([{ label: "Agent", count: 3 }]), "Agent");
  });

  it("空输入不炸", () => {
    assert.equal(preferredLabel([]), "");
  });
});

describe("目录搜索", () => {
  const member = {
    name: "张三",
    bio: "在做检索增强",
    tags: [
      { slug: "rag", label: "RAG" },
      { slug: "agent编排", label: "Agent 编排" },
    ],
  };

  it("搜人名", () => {
    assert.equal(matchesQuery(member, "张三"), true);
    assert.equal(matchesQuery(member, "李四"), false);
  });

  it("搜标签，且大小写空格无关", () => {
    assert.equal(matchesQuery(member, "rag"), true);
    assert.equal(matchesQuery(member, "RAG"), true);
    assert.equal(matchesQuery(member, "agent 编排"), true);
  });

  it("搜简介", () => {
    assert.equal(matchesQuery(member, "检索"), true);
  });

  it("空查询匹配所有人 —— 不该因为没输入就变成空列表", () => {
    assert.equal(matchesQuery(member, ""), true);
    assert.equal(matchesQuery(member, "   "), true);
  });

  it("前缀片段也能命中", () => {
    assert.equal(matchesQuery(member, "ag"), true);
  });
});
