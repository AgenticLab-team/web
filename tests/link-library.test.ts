import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

/**
 * 资源库的入库与可见性。
 *
 * 两条主线：
 *
 * **① 幂等。** 回填会被反复运行（改了抽取规则就要重跑），
 * 不幂等的表现是「被分享 64 次」这种数字凭空冒出来 ——
 * 看起来还挺热闹，其实是跑了六遍，而没有任何地方能看出它是假的。
 *
 * **② 可见性。** 和成员目录同一条规矩：只看得到自己群里分享过的。
 * 连「被分享几次」都只能数你看得到的那些次 ——
 * 用全站次数的话，那个数字本身就泄露了别处的热度。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-links-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";
process.env.SITE_URL = "https://agenticlab.sh";

type DbModule = typeof import("@/lib/db");

let dbm: DbModule;
let schema: typeof import("@/lib/db/schema");
let ingest: typeof import("@/lib/links/ingest");
let queries: typeof import("@/lib/links/queries");

const NOW = 1_800_000_000_000;

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  ingest = await import("@/lib/links/ingest");
  queries = await import("@/lib/links/queries");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  for (const t of [
    schema.linkSaves,
    schema.linkMentions,
    schema.links,
    schema.groupMembers,
    schema.messages,
  ]) {
    dbm.db.delete(t).run();
  }
});

let seq = 0;
function msg(over: Partial<Parameters<typeof ingest.ingestMessages>[0][number]> = {}) {
  return {
    id: `m${++seq}`,
    convId: "g1",
    content: "https://a.com/x",
    ts: NOW,
    senderWxId: "wx_a",
    senderName: "甲",
    type: "text",
    ...over,
  };
}

function allLinks() {
  return dbm.db.select().from(schema.links).all();
}
function mentions() {
  return dbm.db.select().from(schema.linkMentions).all();
}
function joinGroup(convId: string, wxId: string) {
  dbm.db.insert(schema.groupMembers).values({ convId, wxId }).run();
}
function viewer(id: string) {
  return { id, wxId: `wx_${id}` } as never;
}

describe("入库", () => {
  it("一条链接只有一行，不管被分享几次", () => {
    ingest.ingestMessages([
      msg({ content: "https://a.com/x" }),
      msg({ content: "看这个 https://a.com/x", senderName: "乙" }),
    ]);

    assert.equal(allLinks().length, 1);
    assert.equal(allLinks()[0].shareCount, 2);
    assert.equal(mentions().length, 2);
  });

  it("追踪参数不同的算同一条", () => {
    ingest.ingestMessages([
      msg({ content: "https://a.com/x?utm_source=wx" }),
      msg({ content: "https://a.com/x?from=groupmessage" }),
    ]);
    assert.equal(allLinks().length, 1);
  });

  it("**中文粘在后面的链接被摘干净**（真实数据形态）", () => {
    ingest.ingestMessages([
      msg({ content: "https://cloud.siliconflow.cn/i/Ex4mpl3Ab现在硅基流动注册认证给16块钱" }),
    ]);
    assert.equal(allLinks()[0].url, "https://cloud.siliconflow.cn/i/Ex4mpl3Ab");
  });

  it("说明取自消息里的话", () => {
    ingest.ingestMessages([
      msg({ content: "https://typhoon.nmc.cn/web.html 可以查实时台风情报" }),
    ]);
    assert.equal(allLinks()[0].note, "可以查实时台风情报");
  });

  it("没有说明就留空，不编一个", () => {
    ingest.ingestMessages([msg({ content: "https://a.com/x" })]);
    assert.equal(allLinks()[0].note, null);
  });

  it("本站链接不收 —— 塞满自己的页面没有意义", () => {
    const result = ingest.ingestMessages([
      msg({ content: "https://agenticlab.sh/forum/p/1" }),
    ]);
    assert.equal(allLinks().length, 0);
    assert.equal(result.skipped, 1);
  });

  it("内网地址不收", () => {
    ingest.ingestMessages([msg({ content: "http://192.168.1.1/admin" })]);
    assert.equal(allLinks().length, 0);
  });

  it("非文字消息不扫", () => {
    ingest.ingestMessages([msg({ type: "image", content: "https://a.com/x" })]);
    assert.equal(allLinks().length, 0);
  });

  it("首次与最近分享时间取自明细", () => {
    ingest.ingestMessages([
      msg({ ts: NOW }),
      msg({ ts: NOW - 86_400_000 }),
      msg({ ts: NOW + 3600_000 }),
    ]);
    const link = allLinks()[0];
    assert.equal(link.firstSharedAt, NOW - 86_400_000);
    assert.equal(link.lastSharedAt, NOW + 3600_000);
  });
});

describe("幂等 —— 跑六遍不该变成分享 64 次", () => {
  it("**同一批消息重跑，计数不变**", () => {
    const batch = [msg({ content: "https://a.com/x" }), msg({ content: "https://a.com/x" })];

    ingest.ingestMessages(batch);
    const first = allLinks()[0].shareCount;

    for (let i = 0; i < 5; i++) ingest.ingestMessages(batch);

    assert.equal(allLinks().length, 1);
    assert.equal(allLinks()[0].shareCount, first, "重跑之后计数涨了");
    assert.equal(mentions().length, 2);
  });

  it("同一条消息里出现两次同一个链接只记一次", () => {
    ingest.ingestMessages([msg({ content: "https://a.com/x 和 https://a.com/x" })]);
    assert.equal(allLinks()[0].shareCount, 1);
  });

  it("同一条消息里的不同链接分别记", () => {
    ingest.ingestMessages([msg({ content: "https://a.com/x 配合 https://b.com/y" })]);
    assert.equal(allLinks().length, 2);
  });

  it("对账能查出被人手改坏的计数", () => {
    ingest.ingestMessages([msg()]);
    assert.deepEqual(ingest.auditLinkCounts(), []);

    const id = allLinks()[0].id;
    dbm.db.update(schema.links).set({ shareCount: 64 }).where(eq(schema.links.id, id)).run();

    const drift = ingest.auditLinkCounts();
    assert.equal(drift.length, 1);
    assert.equal(drift[0].stored, 64);
    assert.equal(drift[0].actual, 1);
  });

  it("重算能把坏掉的计数修回来", () => {
    ingest.ingestMessages([msg(), msg()]);
    const id = allLinks()[0].id;
    dbm.db.update(schema.links).set({ shareCount: 64 }).where(eq(schema.links.id, id)).run();

    ingest.recountLink(id);
    assert.equal(allLinks()[0].shareCount, 2);
    assert.deepEqual(ingest.auditLinkCounts(), []);
  });

  it("明细清空之后链接本身也不留 —— 零次分享的链接不该在库里", () => {
    ingest.ingestMessages([msg()]);
    const id = allLinks()[0].id;
    dbm.db.delete(schema.linkMentions).run();

    ingest.recountLink(id);
    assert.equal(allLinks().length, 0);
  });
});

describe("可见性 —— 和成员目录同一条规矩", () => {
  beforeEach(() => {
    joinGroup("g1", "wx_me");
    joinGroup("g2", "wx_other");
    ingest.ingestMessages([
      msg({ convId: "g1", content: "https://mine.com/x" }),
      msg({ convId: "g2", content: "https://theirs.com/y" }),
    ]);
  });

  it("**只看得到自己群里分享过的**", () => {
    const result = queries.listLinks(viewer("me"));
    assert.deepEqual(result.items.map((i) => i.domain), ["mine.com"]);
  });

  it("对面看到的也是对称的", () => {
    assert.deepEqual(
      queries.listLinks(viewer("other")).items.map((i) => i.domain),
      ["theirs.com"],
    );
  });

  it("未登录什么都看不到", () => {
    assert.equal(queries.listLinks(null).items.length, 0);
  });

  it("不在任何群里的人看不到", () => {
    assert.equal(queries.listLinks(viewer("nobody")).items.length, 0);
  });

  it("**「被分享 N 次」只数你看得到的那些次**", () => {
    // 同一条链接在两个群里都火过
    ingest.ingestMessages([
      msg({ convId: "g1", content: "https://hot.com/x" }),
      msg({ convId: "g2", content: "https://hot.com/x" }),
      msg({ convId: "g2", content: "https://hot.com/x" }),
      msg({ convId: "g2", content: "https://hot.com/x" }),
    ]);

    const item = queries.listLinks(viewer("me")).items.find((i) => i.domain === "hot.com")!;
    assert.equal(item.visibleShares, 1, "全站次数泄露了别的群的热度");
    assert.equal(item.shareCount, 4, "全站次数本身仍然记着，只是不该显示");
  });

  it("时间也用可见范围里的 —— 和次数一个道理", () => {
    ingest.ingestMessages([
      msg({ convId: "g1", content: "https://hot.com/x", ts: NOW }),
      msg({ convId: "g2", content: "https://hot.com/x", ts: NOW + 86_400_000 }),
    ]);
    const item = queries.listLinks(viewer("me")).items.find((i) => i.domain === "hot.com")!;
    assert.equal(item.lastSharedAt, NOW);
  });

  it("返回结构里没有群 id", () => {
    const serialized = JSON.stringify(queries.listLinks(viewer("me")).items);
    assert.equal(serialized.includes("g1"), false);
    assert.equal(serialized.includes("g2"), false);
  });

  it("**收藏不能成为绕过可见性的后门**", () => {
    const theirs = allLinks().find((l) => l.domain === "theirs.com")!;
    assert.equal(queries.canSeeLink(viewer("me"), theirs.id), false);

    const mine = allLinks().find((l) => l.domain === "mine.com")!;
    assert.equal(queries.canSeeLink(viewer("me"), mine.id), true);
  });

  it("管理员隐藏的不出现在前台", () => {
    const mine = allLinks().find((l) => l.domain === "mine.com")!;
    dbm.db.update(schema.links).set({ hidden: true }).where(eq(schema.links.id, mine.id)).run();
    assert.equal(queries.listLinks(viewer("me")).items.length, 0);
  });
});

describe("筛选与搜索", () => {
  beforeEach(() => {
    joinGroup("g1", "wx_me");
    ingest.ingestMessages([
      msg({ content: "https://github.com/a/b 好用的库" }),
      msg({ content: "https://github.com/c/d" }),
      msg({ content: "https://arxiv.org/abs/2401.1 一篇论文" }),
    ]);
  });

  it("按域名筛", () => {
    const result = queries.listLinks(viewer("me"), { domain: "github.com" });
    assert.equal(result.items.length, 2);
  });

  it("**只出现一次的域名不进筛选栏** —— 点进去看到一条，是噪音", () => {
    const facets = queries.listLinks(viewer("me")).facets;
    assert.deepEqual(facets.map((f) => f.domain), ["github.com"]);
  });

  it("筛选栏有可读的站名", () => {
    assert.equal(queries.listLinks(viewer("me")).facets[0].label, "GitHub");
  });

  it("搜标题、地址、说明", () => {
    assert.equal(queries.listLinks(viewer("me"), { q: "论文" }).items.length, 1);
    assert.equal(queries.listLinks(viewer("me"), { q: "arxiv" }).items.length, 1);
    assert.equal(queries.listLinks(viewer("me"), { q: "a/b" }).items.length, 1);
  });

  it("搜不到时返回空，但筛选栏还在 —— 不然没法换一个条件", () => {
    const result = queries.listLinks(viewer("me"), { q: "不存在的词" });
    assert.equal(result.items.length, 0);
    assert.ok(result.facets.length > 0);
  });

  it("total 是收录总数，不是筛后的数", () => {
    const result = queries.listLinks(viewer("me"), { domain: "arxiv.org" });
    assert.equal(result.total, 3);
    assert.equal(result.items.length, 1);
  });

  it("GitHub 链接显示仓库名，不是一屏 github.com", () => {
    const titles = queries.listLinks(viewer("me"), { domain: "github.com" }).items.map((i) => i.title);
    assert.deepEqual(titles.sort(), ["a/b", "c/d"]);
  });
});
