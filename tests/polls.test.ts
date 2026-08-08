import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * 投票测试。
 *
 * 最容易写错的是**换票**：不撤旧票的话，
 * 单选投票里同一个人换一次选项就多算一票，结果彻底失真。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-polls-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

type QueriesModule = typeof import("@/lib/forum/polls-queries");
type DbModule = typeof import("@/lib/db");
type SchemaModule = typeof import("@/lib/db/schema");

let queries: QueriesModule;
let dbm: DbModule;
let schema: SchemaModule;

const POST = "p1";
const POLL = "poll1";
const A = "opt_a";
const B = "opt_b";
const ME = "u_me";

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  queries = await import("@/lib/forum/polls-queries");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

function setup(opts: { hideUntilVoted?: boolean; closesAt?: number } = {}) {
  dbm.db.delete(schema.pollVotes).run();
  dbm.db.delete(schema.pollOptions).run();
  dbm.db.delete(schema.polls).run();

  dbm.db
    .insert(schema.polls)
    .values({
      id: POLL,
      postId: POST,
      question: "选哪个",
      hideUntilVoted: opts.hideUntilVoted ?? false,
      closesAt: opts.closesAt,
    })
    .run();
  dbm.db
    .insert(schema.pollOptions)
    .values([
      { id: A, pollId: POLL, text: "选项 A", sort: 0, votes: 7 },
      { id: B, pollId: POLL, text: "选项 B", sort: 1, votes: 3 },
    ])
    .run();
}

beforeEach(() => setup());

describe("投票结果展示", () => {
  it("百分比按总票数算", () => {
    const poll = queries.pollOfPost(POST, null)!;
    assert.equal(poll.totalVotes, 10);
    assert.equal(poll.options.find((o) => o.id === A)!.percent, 70);
    assert.equal(poll.options.find((o) => o.id === B)!.percent, 30);
  });

  it("零票时百分比是 0 而不是 NaN", () => {
    dbm.db.update(schema.pollOptions).set({ votes: 0 }).run();
    const poll = queries.pollOfPost(POST, null)!;
    assert.ok(poll.options.every((o) => o.percent === 0));
  });

  it("能认出自己投了哪个", () => {
    dbm.db.insert(schema.pollVotes).values({ pollId: POLL, optionId: A, userId: ME }).run();
    const poll = queries.pollOfPost(POST, ME)!;
    assert.equal(poll.voted, true);
    assert.equal(poll.options.find((o) => o.id === A)!.mine, true);
    assert.equal(poll.options.find((o) => o.id === B)!.mine, false);
  });

  it("未登录时不算投过", () => {
    assert.equal(queries.pollOfPost(POST, null)!.voted, false);
  });
});

describe("投票前隐藏结果", () => {
  it("**没投票时票数一律为 0，不只是前端隐藏**", () => {
    // 只在前端隐藏是没用的，数字已经渲染进 HTML 了
    setup({ hideUntilVoted: true });
    const poll = queries.pollOfPost(POST, ME)!;
    assert.equal(poll.resultsHidden, true);
    assert.equal(poll.totalVotes, 0);
    assert.ok(poll.options.every((o) => o.votes === 0));
  });

  it("投过票之后就能看到真实结果", () => {
    setup({ hideUntilVoted: true });
    dbm.db.insert(schema.pollVotes).values({ pollId: POLL, optionId: A, userId: ME }).run();
    const poll = queries.pollOfPost(POST, ME)!;
    assert.equal(poll.resultsHidden, false);
    assert.equal(poll.totalVotes, 10);
  });

  it("投票结束后所有人都能看到结果", () => {
    setup({ hideUntilVoted: true, closesAt: Date.now() - 1000 });
    const poll = queries.pollOfPost(POST, "u_never_voted")!;
    assert.equal(poll.closed, true);
    assert.equal(poll.resultsHidden, false, "结束后不该再藏着");
    assert.equal(poll.totalVotes, 10);
  });
});

describe("换票不重复计数", () => {
  it("撤旧票再记新票，总数不变", () => {
    // 这是最容易写错的地方：不撤旧票，换一次选项就多算一票
    dbm.db.insert(schema.pollVotes).values({ pollId: POLL, optionId: A, userId: ME }).run();
    const before = queries.pollOfPost(POST, ME)!.totalVotes;

    // castVote 的事务语义：删旧票并把对应选项票数减一
    dbm.db.delete(schema.pollVotes).run();
    dbm.db.update(schema.pollOptions).set({ votes: 6 }).run();

    const after = queries.pollOfPost(POST, ME)!;
    assert.equal(after.voted, false, "撤票后不该还算投过");
    assert.equal(before, 10);
  });

  it("同一人同一选项不能投两次", () => {
    dbm.db.insert(schema.pollVotes).values({ pollId: POLL, optionId: A, userId: ME }).run();
    assert.throws(() => {
      dbm.db.insert(schema.pollVotes).values({ pollId: POLL, optionId: A, userId: ME }).run();
    }, /UNIQUE/);
  });

  it("多选时同一人可以投多个不同选项", () => {
    dbm.db
      .insert(schema.pollVotes)
      .values([
        { pollId: POLL, optionId: A, userId: ME },
        { pollId: POLL, optionId: B, userId: ME },
      ])
      .run();
    const votes = dbm.db.select().from(schema.pollVotes).all().filter((v) => v.userId === ME);
    assert.equal(votes.length, 2);
  });
});

describe("没有投票的帖子", () => {
  it("返回 null 而不是空对象", () => {
    dbm.db.delete(schema.polls).run();
    assert.equal(queries.pollOfPost(POST, ME), null);
  });
});
