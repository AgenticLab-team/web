import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

/**
 * 资源点赞。
 *
 * ─────────────────────────────────────────
 * 和收藏是两件事
 * ─────────────────────────────────────────
 *
 * 收藏是**私人书签**：「我以后要用」，别人看不见。
 * 点赞是**公开信号**：「这个真的有用」，是给下一个翻资源库的人看的。
 *
 * 两者的可见性规则恰恰相反，所以是两张表 ——
 * 一张表里放两套可见性，迟早会有人在某个查询里漏掉那个 type 条件。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-votes-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

let dbm: typeof import("@/lib/db");
let schema: typeof import("@/lib/db/schema");
let q: typeof import("@/lib/links/queries");

const CONV = "room@chatroom";
const U1 = "01USER1000000000000000000";
const U2 = "01USER2000000000000000000";
const LINK = "01LINK000000000000000000A";

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  q = await import("@/lib/links/queries");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  for (const t of [
    schema.linkVotes,
    schema.linkSaves,
    schema.linkMentions,
    schema.links,
    schema.groupMembers,
    schema.groups,
    schema.users,
  ]) {
    dbm.db.delete(t).run();
  }

  dbm.db.insert(schema.groups).values({ convId: CONV, name: "群", syncEnabled: true }).run();
  dbm.db
    .insert(schema.users)
    .values([
      { id: U1, wxId: "wx1", status: "active" },
      { id: U2, wxId: "wx2", status: "active" },
    ])
    .run();
  dbm.db
    .insert(schema.groupMembers)
    .values([
      { convId: CONV, wxId: "wx1", messages: 1 },
      { convId: CONV, wxId: "wx2", messages: 1 },
    ])
    .run();
  dbm.db
    .insert(schema.links)
    .values({
      id: LINK,
      urlKey: "example.com",
      url: "https://example.com/",
      domain: "example.com",
      title: "example.com",
      firstSharedAt: 1000,
      lastSharedAt: 1000,
    })
    .run();
  dbm.db
    .insert(schema.linkMentions)
    .values({ linkId: LINK, convId: CONV, messageId: "m1", sharedAt: 1000 })
    .run();
});

const vote = (userId: string) =>
  dbm.db.insert(schema.linkVotes).values({ userId, linkId: LINK }).onConflictDoNothing().run();

describe("**计数从明细重算，不做 +1**", () => {
  it("重算之后和明细一致", () => {
    vote(U1);
    vote(U2);
    assert.equal(q.recountVotes(LINK), 2);

    const row = dbm.db.select().from(schema.links).where(eq(schema.links.id, LINK)).get()!;
    assert.equal(row.voteCount, 2);
  });

  it("**同一个人点两次只算一票** —— 连点不该变成两票", () => {
    vote(U1);
    vote(U1);
    assert.equal(q.recountVotes(LINK), 1);
  });

  it("取消之后数字跟着降", () => {
    vote(U1);
    vote(U2);
    q.recountVotes(LINK);

    dbm.db.delete(schema.linkVotes).where(eq(schema.linkVotes.userId, U1)).run();
    assert.equal(q.recountVotes(LINK), 1);
  });

  it("**冗余列和明细对不上时，重算能把它拨回来**", () => {
    /*
     * 这正是「从明细重算」的意义:加减法在并发、重试、
     * 用户连点之后会慢慢和明细对不上,而对不上的表现是
     * 「数字有点怪」—— 没有人会为一个有点怪的数字去查明细。
     */
    vote(U1);
    dbm.db.update(schema.links).set({ voteCount: 999 }).where(eq(schema.links.id, LINK)).run();
    assert.equal(q.recountVotes(LINK), 1);
  });

  it("一票都没有时是 0，不是 null", () => {
    assert.equal(q.recountVotes(LINK), 0);
  });
});

describe("列表里带上点赞", () => {
  it("点赞数和「我点没点过」都出来", () => {
    vote(U1);
    vote(U2);
    q.recountVotes(LINK);

    const me = dbm.db.select().from(schema.users).where(eq(schema.users.id, U1)).get()!;
    const item = q.listLinks(me).items.find((i) => i.id === LINK)!;
    assert.equal(item.voteCount, 2);
    assert.equal(item.voted, true);
  });

  it("**别人点过、我没点 —— 数字是公开的，voted 是我的视角**", () => {
    vote(U2);
    q.recountVotes(LINK);

    const me = dbm.db.select().from(schema.users).where(eq(schema.users.id, U1)).get()!;
    const item = q.listLinks(me).items.find((i) => i.id === LINK)!;
    assert.equal(item.voteCount, 1, "别人的赞应该也算进公开计数");
    assert.equal(item.voted, false, "把别人的赞算成了我点的");
  });

  it("按点赞排序时票多的在前", () => {
    dbm.db
      .insert(schema.links)
      .values({
        id: "01LINK000000000000000000B",
        urlKey: "b.com",
        url: "https://b.com/",
        domain: "b.com",
        title: "b.com",
        firstSharedAt: 2000,
        lastSharedAt: 2000,
        voteCount: 0,
      })
      .run();
    dbm.db
      .insert(schema.linkMentions)
      .values({ linkId: "01LINK000000000000000000B", convId: CONV, messageId: "m2", sharedAt: 2000 })
      .run();

    vote(U1);
    vote(U2);
    q.recountVotes(LINK);

    const me = dbm.db.select().from(schema.users).where(eq(schema.users.id, U1)).get()!;
    const items = q.listLinks(me, { sort: "votes" }).items;
    assert.equal(items[0].id, LINK, "票多的没排在前面");
  });

  it("**0 票的那些顺序稳定** —— 不然翻到第二屏会看到刚看过的", () => {
    for (const [i, id] of ["01LINKA00000000000000000A", "01LINKB00000000000000000B"].entries()) {
      dbm.db
        .insert(schema.links)
        .values({
          id,
          urlKey: `x${i}.com`,
          url: `https://x${i}.com/`,
          domain: `x${i}.com`,
          title: `x${i}.com`,
          firstSharedAt: 1000 + i,
          lastSharedAt: 1000 + i,
        })
        .run();
      dbm.db
        .insert(schema.linkMentions)
        .values({ linkId: id, convId: CONV, messageId: `mm${i}`, sharedAt: 1000 + i })
        .run();
    }

    const me = dbm.db.select().from(schema.users).where(eq(schema.users.id, U1)).get()!;
    const a = q.listLinks(me, { sort: "votes" }).items.map((i) => i.id);
    const b = q.listLinks(me, { sort: "votes" }).items.map((i) => i.id);
    assert.deepEqual(a, b);
  });
});

describe("**点赞和收藏互不影响**", () => {
  it("点赞不会让它出现在「我收藏的」里", () => {
    vote(U1);
    q.recountVotes(LINK);

    const me = dbm.db.select().from(schema.users).where(eq(schema.users.id, U1)).get()!;
    const result = q.listLinks(me);
    assert.equal(result.savedCount, 0, "点赞被算成收藏了");
    assert.equal(result.items.find((i) => i.id === LINK)!.saved, false);
  });

  it("收藏不会变成一票", () => {
    dbm.db.insert(schema.linkSaves).values({ userId: U1, linkId: LINK }).run();
    assert.equal(q.recountVotes(LINK), 0);
  });

  it("两张表，不是一张表加 type", () => {
    const src = readFileSync(new URL("../src/lib/db/schema/links.ts", import.meta.url), "utf8");
    assert.match(src, /linkVotes = sqliteTable\(\s*\n?\s*"link_votes"/);
    assert.match(src, /linkSaves = sqliteTable\(\s*\n?\s*"link_saves"/);
  });
});

describe("接线", () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

  it("**点赞也走可见性收口** —— 看不到的东西不该能点", () => {
    const src = strip(readFileSync(new URL("../src/lib/links/actions.ts", import.meta.url), "utf8"));
    const fn = src.slice(src.indexOf("function toggleVoteLink"));
    assert.match(fn.slice(0, 600), /canSeeLink\(user, linkId\)/);
  });

  it("action 里用重算，不用 +1", () => {
    const src = strip(readFileSync(new URL("../src/lib/links/actions.ts", import.meta.url), "utf8"));
    const fn = src.slice(src.indexOf("function toggleVoteLink"));
    assert.match(fn.slice(0, 1200), /recountVotes\(linkId\)/);
    assert.doesNotMatch(fn.slice(0, 1200), /voteCount \+ 1|voteCount: sql/);
  });

  it("**失败时数字要一起拨回去** —— 只拨图标会留下一个和服务端对不上的计数", () => {
    const src = readFileSync(
      new URL("../src/components/links/VoteButton.tsx", import.meta.url),
      "utf8",
    );
    assert.match(src, /setCount\(prevCount\)/);
  });

  it("成功后用服务端重算的数，不用本地乐观值", () => {
    const src = readFileSync(
      new URL("../src/components/links/VoteButton.tsx", import.meta.url),
      "utf8",
    );
    assert.match(src, /result\.voteCount === "number"/);
  });

  it("按钮有可访问的名字，而且带上当前票数", () => {
    const src = readFileSync(
      new URL("../src/components/links/VoteButton.tsx", import.meta.url),
      "utf8",
    );
    assert.match(src, /aria-label=/);
    assert.match(src, /aria-pressed=/);
    assert.match(src, /当前 \$\{count\} 赞/);
  });

  it("用 SVG 图标不用 emoji", () => {
    const src = readFileSync(
      new URL("../src/components/links/VoteButton.tsx", import.meta.url),
      "utf8",
    );
    assert.match(src, /lucide-react/);
    assert.doesNotMatch(src, /[\u{1F300}-\u{1FAFF}]/u);
  });

  it("资源库页面真的用上了这个按钮和排序", () => {
    const page = readFileSync(new URL("../src/app/(app)/links/page.tsx", import.meta.url), "utf8");
    assert.match(page, /<VoteButton/);
    assert.match(page, /最有用/);
  });
});
