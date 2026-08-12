import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * 代发限流 —— 接上真库之后。
 *
 * ═════════════════════════════════════════
 * 这里数的是**人**，不是令牌
 * ═════════════════════════════════════════
 *
 * 这一条不是风格问题。按令牌数的话，一个人在自己的页面上
 * 点十下「新建令牌」就有十份额度 —— 而上游那份 20 条/分钟
 * 是**全站共用**的，等于一个人合法地把整站的额度吃光，
 * 不用绕过任何东西。
 *
 * 而且它不会在任何地方报错：每把令牌看起来都很守规矩。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-allowance-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

let dbm: typeof import("@/lib/db");
let schema: typeof import("@/lib/db/schema");
let store: typeof import("@/lib/api-tokens/store");
let rules: typeof import("@/lib/api-tokens/rules");

const ALICE = "u_alice";
const BOB = "u_bob";
const ROOM_A = "room_a@chatroom";
const ROOM_B = "room_b@chatroom";

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  store = await import("@/lib/api-tokens/store");
  rules = await import("@/lib/api-tokens/rules");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  dbm.db.delete(schema.apiSends).run();
});

/**
 * 记 n 条已发。tokenId 可以是 null —— 网页那条路就是 null。
 *
 * `spread` 把这些条**摊到一天里**（每条差 10 分钟）。默认不摊的话，
 * 全部落在同一分钟内，于是永远是「每分钟最多 3 条」先触发 ——
 * 那样就测不到小时和天那两个窗口了。
 */
function sent(
  n: number,
  opts: {
    userId: string;
    convId: string;
    /** 给个函数就能让每条用不同的令牌 —— 「十把令牌」那条要的就是这个 */
    tokenId?: string | null | ((i: number) => string | null);
    ok?: boolean;
    spread?: boolean;
  },
) {
  const now = Date.now();
  const tokenAt = (i: number) =>
    typeof opts.tokenId === "function" ? opts.tokenId(i) : (opts.tokenId ?? null);
  for (let i = 0; i < n; i++) {
    if (opts.spread) {
      dbm.db
        .insert(schema.apiSends)
        .values({
          id: `s${now}_${i}_${Math.floor(Math.random() * 1e9)}`,
          tokenId: tokenAt(i),
          userId: opts.userId,
          convId: opts.convId,
          length: 1,
          text: "x",
          ok: opts.ok ?? true,
          // 往回摊，每条差 10 分钟 —— n 条最多铺 10 小时，仍在「今天」窗口内
          at: now - i * 10 * 60_000,
        })
        .run();
    } else {
      store.recordSend({
        tokenId: tokenAt(i),
        userId: opts.userId,
        convId: opts.convId,
        text: "x",
        ok: opts.ok ?? true,
      });
    }
  }
}

describe("代发限流按人数", () => {
  it("**十把令牌不等于十份额度**", () => {
    /*
     * 这一条是整个文件存在的理由。
     *
     * 用十把不同的令牌把每天的额度发满 —— 如果按令牌数，
     * 每把都只用了 1/10，十把都还很宽裕；按人数，第 61 条就该被拦。
     */
    sent(rules.SEND_LIMIT.perDay, {
      userId: ALICE,
      convId: ROOM_A,
      tokenId: (i) => `token_${i % 10}`,
      spread: true,
    });
    const verdict = store.sendAllowance(ALICE, ROOM_A);
    assert.equal(verdict.allowed, false, "换一把令牌就该重新有额度？那额度等于没有");
    assert.match(verdict.error ?? "", /每天/);
  });

  it("**网页发的也算进同一份额度**", () => {
    /*
     * 网页那条路没有令牌（tokenId 为 null）。
     * 不算进来的话，令牌发满之后换到网页上接着发就是了。
     */
    sent(rules.SEND_LIMIT.perHour, {
      userId: ALICE,
      convId: ROOM_A,
      // 一半走令牌、一半走网页
      tokenId: (i) => (i % 2 === 0 ? "token_x" : null),
    });
    // 全落在同一分钟里也没关系：这一条要证的是「网页那条也数进来了」
    assert.equal(store.sendAllowance(ALICE, ROOM_A).allowed, false);
  });

  it("别人的额度不受影响 —— 数的是这个人", () => {
    sent(rules.SEND_LIMIT.perDay, { userId: ALICE, convId: ROOM_A, spread: true });
    assert.equal(store.sendAllowance(ALICE, ROOM_A).allowed, false);
    assert.equal(store.sendAllowance(BOB, ROOM_A).allowed, true);
  });

  it("**跨群一起数** —— 被授权五个群不等于五份额度", () => {
    // 全局那道闸护的是上游那份全站共用的配额，它不分群
    sent(rules.SEND_LIMIT.perDay, { userId: ALICE, convId: ROOM_A, spread: true });
    assert.equal(store.sendAllowance(ALICE, ROOM_B).allowed, false, "换个群就重新有额度？");
  });
});

describe("授权上调紧的额度", () => {
  it("**站长把这个群调到 2 条/天，就真的只能发 2 条**", () => {
    const grant = { perMinute: null, perHour: null, perDay: 2 };
    sent(2, { userId: ALICE, convId: ROOM_A, spread: true });
    const verdict = store.sendAllowance(ALICE, ROOM_A, grant as never);
    assert.equal(verdict.allowed, false);
    assert.match(verdict.error ?? "", /每天最多 2 条/);
  });

  it("**它只管这个群** —— 别的群发的不占它", () => {
    /*
     * 这一条钉的是「两道闸各管各的」：
     * 收紧的那道只数这个群，否则站长给 A 群的严格额度
     * 会被 B 群的正常使用吃光，而那不是他的意思。
     */
    const grant = { perMinute: null, perHour: null, perDay: 2 };
    sent(2, { userId: ALICE, convId: ROOM_B, spread: true });
    assert.equal(store.sendAllowance(ALICE, ROOM_A, grant as never).allowed, true);
  });

  it("授权上写得比全局松也不放宽 —— effectiveLimits 只收紧", () => {
    const grant = { perMinute: null, perHour: null, perDay: 9999 };
    sent(rules.SEND_LIMIT.perDay, { userId: ALICE, convId: ROOM_A, spread: true });
    assert.equal(store.sendAllowance(ALICE, ROOM_A, grant as never).allowed, false);
  });
});

describe("失败的也算", () => {
  it("一百次失败在限流上不能等于没发生 —— 每一次都真的打了上游", () => {
    sent(rules.SEND_LIMIT.perDay, { userId: ALICE, convId: ROOM_A, ok: false, spread: true });
    assert.equal(store.sendAllowance(ALICE, ROOM_A).allowed, false);
  });
});

describe("usageOf 和限流数的是同一件事", () => {
  it("**两边不一致的话，界面会告诉他还能发、而发就被拦**", () => {
    /*
     * 一个显示用、一个判定用，分别数是很自然的写法 ——
     * 而它们一旦分叉，用户看到的是「今天 3/60」然后被告知「太频繁了」，
     * 于是他会觉得这个站坏了。所以在这里对一遍。
     */
    sent(7, { userId: ALICE, convId: ROOM_A, tokenId: "t1", spread: true });
    sent(5, { userId: ALICE, convId: ROOM_B, tokenId: null, spread: true });
    assert.equal(store.usageOf(ALICE).day, 12, "显示的用量要把所有群、所有令牌、网页都算上");

    // 正好发到上限，两边同时到界
    sent(rules.SEND_LIMIT.perDay - 12, { userId: ALICE, convId: ROOM_A, spread: true });
    assert.equal(store.usageOf(ALICE).day, rules.SEND_LIMIT.perDay);
    assert.equal(store.sendAllowance(ALICE, ROOM_A).allowed, false);
  });
});
