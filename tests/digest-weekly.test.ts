import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_WECHAT_LENGTH } from "@/lib/broadcast/rules";
import {
  MAX_ITEMS,
  MIN_ENGAGEMENT,
  isBroadcastable,
  renderDigest,
  reasonFor,
  scorePost,
  selectDigest,
  shouldPublish,
  weekLabel,
  weekStartOf,
  type DigestCandidate,
} from "@/lib/digest/weekly";

/**
 * 每周精选的选稿规则。
 *
 * 最要紧的一条：**精选是一条发进所有群的消息**。
 * 只要有一条「仅 A 群可见」的帖子混进去，它就会被念给 B 群听 ——
 * 而那条消息发出去之后收不回来（撤回窗口只有两分钟）。
 */

const NOW = 1_800_000_000_000;

function post(over: Partial<DigestCandidate> = {}): DigestCandidate {
  return {
    id: `p${Math.random().toString(36).slice(2, 8)}`,
    title: "一个帖子",
    excerpt: "摘要",
    authorName: "张三",
    visibility: "member",
    status: "published",
    featured: false,
    replyCount: 3,
    reactionCount: 2,
    viewCount: 100,
    createdAt: NOW,
    fromGroupChat: false,
    ...over,
  };
}

describe("可见性 —— 只收所有社群成员都能看的", () => {
  it("**限定范围的帖子一律不进精选**", () => {
    for (const visibility of ["role", "group", "private"] as const) {
      const selection = selectDigest([post({ visibility })]);
      assert.equal(selection.items.length, 0, `${visibility} 混进了精选`);
      assert.match(selection.rejected[0].reason, /不能发进所有群/);
    }
  });

  it("公开 / 未列出 / 成员可见的可以进", () => {
    for (const visibility of ["public", "unlisted", "member"] as const) {
      assert.equal(isBroadcastable(visibility), true);
      assert.equal(selectDigest([post({ visibility })]).items.length, 1);
    }
  });

  it("**用白名单而不是黑名单** —— 新增一个可见性级别时默认应该是不发", () => {
    // 黑名单写法的问题是新级别会默认放行，而那次放行没人会注意到
    assert.equal(isBroadcastable("brand_new" as never), false);
  });

  it("群聊转帖只要可见性够宽也能进 —— 挡的是范围，不是来源", () => {
    const selection = selectDigest([post({ fromGroupChat: true, visibility: "member" })]);
    assert.equal(selection.items.length, 1);
  });

  it("群聊转帖被锁在原群时挡下", () => {
    const selection = selectDigest([post({ fromGroupChat: true, visibility: "group" })]);
    assert.equal(selection.items.length, 0);
  });

  it("没发布的不进：草稿、隐藏、已删", () => {
    for (const status of ["draft", "hidden", "deleted", "scheduled"]) {
      const selection = selectDigest([post({ status })]);
      assert.equal(selection.items.length, 0, status);
      assert.match(selection.rejected[0].reason, new RegExp(status));
    }
  });
});

describe("够不够格", () => {
  it("互动太少的不进 —— 否则精选就只是「最近发了什么」", () => {
    const selection = selectDigest([post({ replyCount: 0, reactionCount: 1 })]);
    assert.equal(selection.items.length, 0);
    assert.match(selection.rejected[0].reason, /够不上/);
  });

  it("刚好到线的进", () => {
    assert.equal(
      selectDigest([post({ replyCount: 0, reactionCount: MIN_ENGAGEMENT })]).items.length,
      1,
    );
  });

  it("**加精的帖子不看互动数** —— 编辑已经替它背过书了", () => {
    const selection = selectDigest([post({ featured: true, replyCount: 0, reactionCount: 0 })]);
    assert.equal(selection.items.length, 1);
  });

  it("往期发过的不重复发", () => {
    const p = post({ id: "seen" });
    const selection = selectDigest([p], { alreadySent: new Set(["seen"]) });
    assert.equal(selection.items.length, 0);
    assert.match(selection.rejected[0].reason, /往期/);
  });

  it("最多几条就是几条", () => {
    const many = Array.from({ length: MAX_ITEMS + 5 }, () => post());
    assert.equal(selectDigest(many).items.length, MAX_ITEMS);
  });
});

describe("排序", () => {
  it("**回复比表情重要** —— 表情是一秒钟的事，回复是有人真的写了点什么", () => {
    assert.ok(scorePost(post({ replyCount: 1, reactionCount: 0 })) > scorePost(post({ replyCount: 0, reactionCount: 2 })));
  });

  it("**加精压得过一般热度的帖子** —— 否则加精就没有意义", () => {
    const selection = selectDigest([
      post({ id: "hot", replyCount: 3, reactionCount: 3 }),
      post({ id: "featured", featured: true, replyCount: 0, reactionCount: 0 }),
    ]);
    assert.equal(selection.items[0].id, "featured");
  });

  it("但压不过真正的热帖 —— 加精不是无穷大", () => {
    const selection = selectDigest([
      post({ id: "veryhot", replyCount: 20, reactionCount: 10 }),
      post({ id: "featured", featured: true, replyCount: 0, reactionCount: 0 }),
    ]);
    assert.equal(selection.items[0].id, "veryhot");
  });

  it("**浏览数不算分** —— 它反映的是标题好不好，不是内容值不值得再看", () => {
    const a = scorePost(post({ viewCount: 10_000, replyCount: 1, reactionCount: 0 }));
    const b = scorePost(post({ viewCount: 3, replyCount: 1, reactionCount: 0 }));
    assert.equal(a, b);
  });

  it("同分时新的排前面", () => {
    const selection = selectDigest([
      post({ id: "old", createdAt: NOW - 86_400_000 }),
      post({ id: "new", createdAt: NOW }),
    ]);
    assert.equal(selection.items[0].id, "new");
  });

  it("每条都说得出为什么在这儿", () => {
    assert.equal(reasonFor(post({ featured: true })), "已加精");
    assert.match(reasonFor(post({ replyCount: 7 })), /7 条回复/);
    assert.match(reasonFor(post({ replyCount: 0, reactionCount: 4 })), /4 个表情/);
    for (const item of selectDigest([post()]).items) {
      assert.ok(item.reason.length > 1, "精选里有一条说不出理由的");
    }
  });
});

describe("该不该发这一周", () => {
  it("**一条都没有就不发** —— 一条空的精选教会所有人以后忽略它", () => {
    const verdict = shouldPublish(selectDigest([]));
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /不发比发一条空的好/);
  });

  it("只有一条也不发 —— 比没有精选更显得冷清", () => {
    const verdict = shouldPublish(selectDigest([post()]));
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /冷清/);
  });

  it("两条以上就可以发", () => {
    const verdict = shouldPublish(selectDigest([post(), post()]));
    assert.equal(verdict.ok, true);
    assert.match(verdict.reason, /2 条/);
  });

  it("门槛可调，但默认不是 1", () => {
    assert.equal(shouldPublish(selectDigest([post(), post(), post()]), 3).ok, true);
    assert.equal(shouldPublish(selectDigest([post(), post()]), 3).ok, false);
  });
});

describe("文案", () => {
  const opts = { siteUrl: "https://agenticlab.sh", weekLabel: "8 月 3 日那周" };

  it("**每条都带链接** —— 看得见标题却打不开只会让人来群里问", () => {
    const items = selectDigest([post({ id: "abc123", title: "怎么做 RAG" })]).items;
    const text = renderDigest(items, opts);
    assert.match(text, /https:\/\/agenticlab\.sh\/forum\/p\/abc123/);
    assert.match(text, /怎么做 RAG/);
  });

  it("带上作者与入选理由", () => {
    const text = renderDigest(selectDigest([post({ authorName: "李四", replyCount: 6 })]).items, opts);
    assert.match(text, /李四/);
    assert.match(text, /6 条回复/);
  });

  it("末尾有回站里看全部的入口", () => {
    assert.match(renderDigest(selectDigest([post()]).items, opts), /agenticlab\.sh\/forum$/);
  });

  it("**超长时少放几条，不从中间截断** —— 截断会切出半个链接", () => {
    const long = Array.from({ length: 5 }, (_, i) =>
      post({ id: `p${i}`, title: "很长的标题".repeat(30), excerpt: "很长的摘要".repeat(30) }),
    );
    const text = renderDigest(selectDigest(long).items, { ...opts, maxLength: 400 });

    assert.ok(text.length <= 400, `渲染出 ${text.length} 字，超了`);
    // 不能出现半截链接（末尾那行「完整列表：…」带前缀，另算）
    for (const line of text.split("\n")) {
      if (!line.includes("http")) continue;
      const url = line.trim().replace(/^完整列表：/, "");
      assert.match(url, /^https:\/\/agenticlab\.sh\/forum(\/p\/\w+)?$/, `半截链接：${line}`);
    }
  });

  it("默认长度上限跟群发规则一致 —— 两处各写一个数迟早会错开", () => {
    const many = Array.from({ length: 5 }, () =>
      post({ title: "标题".repeat(40), excerpt: "摘要".repeat(40) }),
    );
    const text = renderDigest(selectDigest(many).items, opts);
    assert.ok(text.length <= MAX_WECHAT_LENGTH);
  });

  it("末尾多余的斜杠不会拼出双斜杠", () => {
    const text = renderDigest(selectDigest([post({ id: "x" })]).items, {
      ...opts,
      siteUrl: "https://agenticlab.sh/",
    });
    assert.equal(text.includes("sh//"), false);
  });
});

describe("周的边界", () => {
  it("周一为起点", () => {
    // 2026-08-03 是周一
    assert.equal(weekStartOf("2026-08-03"), "2026-08-03");
    assert.equal(weekStartOf("2026-08-09"), "2026-08-03", "周日应该归到上一个周一");
    assert.equal(weekStartOf("2026-08-10"), "2026-08-10", "下一个周一另起一周");
  });

  it("**不用周日切周** —— 那会把一段连续的讨论劈成两周", () => {
    const friday = weekStartOf("2026-08-07");
    const saturday = weekStartOf("2026-08-08");
    const sunday = weekStartOf("2026-08-09");
    assert.equal(friday, saturday);
    assert.equal(saturday, sunday);
  });

  it("跨月也对", () => {
    assert.equal(weekStartOf("2026-09-01"), "2026-08-31");
  });

  it("周标签说人话", () => {
    assert.equal(weekLabel("2026-08-03"), "8 月 3 日那周");
    assert.equal(weekLabel("2026-12-28"), "12 月 28 日那周");
  });
});
