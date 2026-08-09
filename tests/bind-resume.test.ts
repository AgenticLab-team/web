import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * 绑定流程的断线恢复。
 *
 * 微信内置浏览器杀后台是常态，「关掉再打开」不是异常路径。
 * 原来每次打开登录页都发一个新码 —— 生产上一天 392 个码、235 个
 * 从没匹配上，很大一部分就是同一个人反复打开页面造成的。
 *
 * 这组测试盯住三件事：
 *   1. 5 分钟内带着原 nonce 回来，拿到的是**同一个码**，不是新码
 *   2. 已经在群里发过码、只差建会话的人，回来能直接续上
 *   3. 恢复不占取码限流的额度 —— 被杀过后台的人不该更接近 429
 */

const tmp = mkdtempSync(join(tmpdir(), "al-bindresume-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

let dbm: typeof import("@/lib/db");
let schema: typeof import("@/lib/db/schema");
let bind: typeof import("@/lib/auth/bind");

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  bind = await import("@/lib/auth/bind");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  dbm.db.delete(schema.bindCodes).run();
});

function codeRows() {
  return dbm.db.select().from(schema.bindCodes).all();
}

describe("**5 分钟内重开页面，接回同一个码**", () => {
  it("带原 nonce 回来：同码、同 nonce、不落新行", () => {
    const first = bind.startBind({ ip: "1.1.1.1" });
    const again = bind.startBind({ ip: "1.1.1.1", resumeNonce: first.nonce });

    assert.equal(again.resumed, true);
    assert.equal(again.code, first.code, "重开页面换了码 —— 这正是 235 个死码的来源");
    assert.equal(again.nonce, first.nonce);
    assert.equal(codeRows().length, 1, "恢复不该再插一行");
  });

  it("**issuedAt 是最初签发的时间** —— 「你 N 分钟前的登录」这句话靠它", () => {
    const first = bind.startBind({ ip: "1.1.1.1" });
    const again = bind.startBind({ ip: "1.1.1.1", resumeNonce: first.nonce });
    assert.equal(again.issuedAt, first.issuedAt);
  });

  it("**恢复不重置有效期** —— 否则反复刷新能把 5 分钟的码续成永动机", () => {
    const first = bind.startBind({ ip: "1.1.1.1" });
    const again = bind.startBind({ ip: "1.1.1.1", resumeNonce: first.nonce });
    assert.equal(again.expiresAt, first.expiresAt);
  });

  it("不带 nonce 就还是新码 —— 换台设备重开不该拿到别人的码", () => {
    const first = bind.startBind({ ip: "1.1.1.1" });
    const other = bind.startBind({ ip: "1.1.1.1" });
    assert.equal(other.resumed, false);
    assert.notEqual(other.nonce, first.nonce);
    assert.equal(codeRows().length, 2);
  });

  it("nonce 对不上任何记录：发新码，不炸", () => {
    const r = bind.startBind({ ip: "1.1.1.1", resumeNonce: "no-such-nonce" });
    assert.equal(r.resumed, false);
  });
});

describe("码已经过了各种「不能接」的状态", () => {
  it("**pending 但已过期：发新码** —— 过期的码上游早就不匹配了，接回来是骗人等", () => {
    const first = bind.startBind({ ip: "1.1.1.1" });
    dbm.db
      .update(schema.bindCodes)
      .set({ expiresAt: Date.now() - 1000 })
      .run();

    const again = bind.startBind({ ip: "1.1.1.1", resumeNonce: first.nonce });
    assert.equal(again.resumed, false);
    assert.notEqual(again.code, first.code);
  });

  it("被作废（revoked）的不接回 —— 管理员作废就是要它死透", () => {
    const first = bind.startBind({ ip: "1.1.1.1" });
    dbm.db.update(schema.bindCodes).set({ status: "revoked" }).run();

    const again = bind.startBind({ ip: "1.1.1.1", resumeNonce: first.nonce });
    assert.equal(again.resumed, false);
  });
});

describe("**发完码才被杀后台的人，回来直接续上**", () => {
  /*
   * 这是最亏的一种失败：人已经做完了所有该做的事（码在群里发出去、
   * 匹配上了），只差前端把会话建起来。这时按码的 expiresAt 判是错的 ——
   * 发得晚的话它可能已经过了 —— 要按匹配时间另开一扇窗。
   */
  it("used 且刚匹配完：接回，且展示时限不早于现在", () => {
    const first = bind.startBind({ ip: "1.1.1.1" });
    const now = Date.now();
    dbm.db
      .update(schema.bindCodes)
      .set({
        status: "used",
        matchedWxId: "wxid_x",
        matchedAt: now - 60_000,
        usedAt: now - 60_000,
        // 匹配发生在码的最后一刻，expiresAt 已经过了
        expiresAt: now - 1000,
      })
      .run();

    const again = bind.startBind({ ip: "1.1.1.1", resumeNonce: first.nonce });
    assert.equal(again.resumed, true);
    assert.equal(again.code, first.code);
    /*
     * 前端在倒计时归零时会把整页判成「已过期」并停掉轮询 ——
     * 展示时限要是还停在过去，页面会抢在轮询拿到 bound 之前宣布死亡。
     */
    assert.ok(again.expiresAt > now, "展示时限还在过去，前端会立刻判过期");
  });

  it("匹配已经超过 5 分钟：不接，发新码", () => {
    const first = bind.startBind({ ip: "1.1.1.1" });
    dbm.db
      .update(schema.bindCodes)
      .set({
        status: "used",
        matchedWxId: "wxid_x",
        matchedAt: Date.now() - bind.RESUME_WINDOW_MS - 1000,
        expiresAt: Date.now() - 1000,
      })
      .run();

    const again = bind.startBind({ ip: "1.1.1.1", resumeNonce: first.nonce });
    assert.equal(again.resumed, false);
  });
});

describe("**恢复不占限流额度**", () => {
  it("额度用完之后，带 nonce 恢复照样成功", () => {
    /*
     * 反过来的话最惨的正是最需要恢复的人：微信杀了他五次后台，
     * 第六次打开直接 429 —— 于是「恢复登录进度」这个功能
     * 在它唯一的目标人群身上失效。
     */
    const first = bind.startBind({ ip: "9.9.9.9" });
    // burst_limit 默认 5：把剩余额度烧光
    for (let i = 0; i < 4; i++) bind.startBind({ ip: "9.9.9.9" });
    assert.throws(() => bind.startBind({ ip: "9.9.9.9" }), bind.RateLimitError);

    const again = bind.startBind({ ip: "9.9.9.9", resumeNonce: first.nonce });
    assert.equal(again.resumed, true);
    assert.equal(again.code, first.code);
  });

  it("**接不回时限流照常生效** —— 复用通道不能变成绕过限流的后门", () => {
    for (let i = 0; i < 5; i++) bind.startBind({ ip: "8.8.8.8" });
    assert.throws(
      () => bind.startBind({ ip: "8.8.8.8", resumeNonce: "no-such-nonce" }),
      bind.RateLimitError,
    );
  });
});
