import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";



/**
 * 绑定审批队列 —— 接上真库之后。
 *
 * 重点在两处:活跃度算得对不对（它是审批的全部依据）、
 * 「今天已经通过几个」能不能从审计日志里数出来
 * （服务端不再拦之后，这个数字是界面上仅剩的风控提醒）。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-bindq-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

let dbm: typeof import("@/lib/db");
let schema: typeof import("@/lib/db/schema");
let q: typeof import("@/lib/auth/bind-queue-queries");

const WX = "wxid_applicant";
const CONV_A = "room_a@chatroom";
const CONV_B = "room_b@chatroom";

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  q = await import("@/lib/auth/bind-queue-queries");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  for (const t of [
    schema.auditLogs,
    schema.bindCodes,
    schema.messages,
    schema.groupMembers,
    schema.groups,
    schema.users,
  ]) {
    dbm.db.delete(t).run();
  }

  dbm.db
    .insert(schema.groups)
    .values([
      { convId: CONV_A, name: "AI 实验室" },
      { convId: CONV_B, name: "读书会" },
    ])
    .run();
});

function joinGroup(convId: string, opts: { messages?: number; leftAt?: number } = {}) {
  dbm.db
    .insert(schema.groupMembers)
    .values({
      convId,
      wxId: WX,
      wxName: "申请人",
      messages: opts.messages ?? 10,
      joinedAt: Date.now() - 30 * 86_400_000,
      leftAt: opts.leftAt,
    })
    .run();
}

describe("活跃度", () => {
  it("在两个群里就都列出来 —— 用群名，不是 conv id", () => {
    joinGroup(CONV_A, { messages: 30 });
    joinGroup(CONV_B, { messages: 12 });

    const a = q.applicantActivity(WX);
    assert.deepEqual(a.groups.sort(), ["AI 实验室", "读书会"]);
    assert.equal(a.messages, 42, "两个群的条数要加起来");
  });

  it("**退了群的不算** —— 退群的人不再是群成员", () => {
    joinGroup(CONV_A, { messages: 30 });
    joinGroup(CONV_B, { messages: 12, leftAt: Date.now() });

    const a = q.applicantActivity(WX);
    assert.deepEqual(a.groups, ["AI 实验室"]);
    assert.equal(a.messages, 30, "退掉那个群的消息数还算着");
  });

  it("**全退了就是 0 个群** —— 这样的人手动绑定会被拒", () => {
    joinGroup(CONV_A, { leftAt: Date.now() });
    assert.deepEqual(q.applicantActivity(WX).groups, []);
  });

  it("不在任何群里的人查出来是空的，不炸", () => {
    const a = q.applicantActivity("wxid_nobody");
    assert.deepEqual(a.groups, []);
    assert.equal(a.messages, 0);
    assert.equal(a.lastSeenAt, null);
  });

  it("最后一条消息的时间取最新的那条", () => {
    joinGroup(CONV_A);
    dbm.db
      .insert(schema.messages)
      .values([
        { id: "m1", convId: CONV_A, senderWxId: WX, ts: 1000, type: "text", content: "早" },
        { id: "m2", convId: CONV_A, senderWxId: WX, ts: 5000, type: "text", content: "晚" },
        { id: "m3", convId: CONV_A, senderWxId: WX, ts: 3000, type: "text", content: "中" },
      ])
      .run();

    assert.equal(q.applicantActivity(WX).lastSeenAt, 5000);
  });

  it("别人的消息不算到他头上", () => {
    joinGroup(CONV_A);
    dbm.db
      .insert(schema.messages)
      .values({ id: "m1", convId: CONV_A, senderWxId: "wxid_other", ts: 9999, type: "text", content: "x" })
      .run();
    assert.equal(q.applicantActivity(WX).lastSeenAt, null);
  });

  it("入群时间取最早的那个群", () => {
    dbm.db
      .insert(schema.groupMembers)
      .values([
        { convId: CONV_A, wxId: WX, messages: 1, joinedAt: 5000 },
        { convId: CONV_B, wxId: WX, messages: 1, joinedAt: 2000 },
      ])
      .run();
    assert.equal(q.applicantActivity(WX).joinedAt, 2000);
  });
});

describe("**「今天已经通过几个」从审计日志里数**", () => {
  const logAccept = (at: number) =>
    dbm.db
      .insert(schema.auditLogs)
      .values({
        action: q.FRIEND_ACCEPT_ACTION,
        actorId: "01ADMIN000000000000000000",
        targetType: "wx_id",
        targetId: "wxid_x",
        createdAt: at,
      })
      .run();

  it("没通过过的时候额度是满的", () => {
    assert.equal(q.currentAcceptBudget().usedToday > 0, false);
  });

  it("通过过就数得出来", () => {
    const now = Date.now();
    logAccept(now - 3600_000);
    logAccept(now - 7200_000);
    assert.equal(q.currentAcceptBudget(now).usedToday, 2);
  });

  it("**24 小时以外的不算** —— 额度是滚动的", () => {
    const now = Date.now();
    logAccept(now - 25 * 3600_000);
    assert.equal(q.currentAcceptBudget(now).usedToday, 0);
  });

  it("**只数通过好友这一种动作** —— 别的审计不该吃掉额度", () => {
    const now = Date.now();
    dbm.db
      .insert(schema.auditLogs)
      .values({
        action: "user.suspend",
        actorId: "01ADMIN000000000000000000",
        createdAt: now - 1000,
      })
      .run();
    assert.equal(q.currentAcceptBudget(now).usedToday, 0);
  });
});

describe("没完成的绑定", () => {
  const makeBind = (o: {
    createdAt: number;
    expiresAt: number;
    matchedAt?: number;
    ip?: string;
  }) =>
    dbm.db
      .insert(schema.bindCodes)
      .values({
        code: String(100000 + (o.createdAt % 900000)),
        sessionNonce: `nonce-${o.createdAt}-${o.ip ?? "a"}`,
        createdAt: o.createdAt,
        expiresAt: o.expiresAt,
        matchedAt: o.matchedAt,
        issuedIp: o.ip ?? "1.2.3.4",
      })
      .run();

  it("**只取过一次码的不算卡住** —— 打开登录页就会取一个码", () => {
    /*
     * 生产上量过:一天 392 个码、235 个从没匹配上,
     * 绝大多数只是有人点开看了一眼。
     * 按那个口径做出来的队列每天两百多条,而两百多条的队列没有人会看。
     */
    const now = Date.now();
    makeBind({ createdAt: now - 600_000, expiresAt: now - 300_000, ip: "1.1.1.1" });
    assert.deepEqual(q.stalledBinds(), []);
  });

  it("反复取码才进队列", () => {
    const now = Date.now();
    makeBind({ createdAt: now - 900_000, expiresAt: now - 600_000, ip: "1.1.1.1" });
    makeBind({ createdAt: now - 600_000, expiresAt: now - 300_000, ip: "1.1.1.1" });

    const rows = q.stalledBinds();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].codes, 2);
    assert.equal(rows[0].ip, "1.1.1.1");
    assert.equal(rows[0].expired, true);
  });

  it("**不同 IP 分开算** —— 两个人各取一次不该凑成一个卡住的人", () => {
    const now = Date.now();
    makeBind({ createdAt: now - 900_000, expiresAt: now - 600_000, ip: "1.1.1.1" });
    makeBind({ createdAt: now - 600_000, expiresAt: now - 300_000, ip: "2.2.2.2" });
    assert.deepEqual(q.stalledBinds(), []);
  });

  it("要处理的是**最近那个码**，不是第一个", () => {
    const now = Date.now();
    makeBind({ createdAt: now - 900_000, expiresAt: now - 600_000, ip: "1.1.1.1" });
    makeBind({ createdAt: now - 60_000, expiresAt: now + 240_000, ip: "1.1.1.1" });

    const row = q.stalledBinds()[0];
    assert.equal(row.expired, false, "拿的是过期的那个码");
    assert.equal(row.firstAt, now - 900_000);
    assert.equal(row.lastAt, now - 60_000);
  });

  it("试得最多的排最前 —— 他最需要有人管", () => {
    const now = Date.now();
    for (let i = 0; i < 2; i++) makeBind({ createdAt: now - 900_000 - i, expiresAt: now, ip: "1.1.1.1" });
    for (let i = 0; i < 4; i++) makeBind({ createdAt: now - 800_000 - i, expiresAt: now, ip: "2.2.2.2" });

    const rows = q.stalledBinds();
    assert.equal(rows[0].ip, "2.2.2.2");
    assert.equal(rows[0].codes, 4);
  });

  it("**已经匹配上的不进队列** —— 那人已经进来了", () => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      makeBind({
        createdAt: now - 600_000 - i,
        expiresAt: now + 300_000,
        matchedAt: now - 500_000,
        ip: "1.1.1.1",
      });
    }
    assert.deepEqual(q.stalledBinds(), []);
  });

  it("**超过一天的不再显示** —— 越堆越长的队列等于没有队列", () => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      makeBind({ createdAt: now - 25 * 3600_000 - i, expiresAt: now - 24 * 3600_000, ip: "1.1.1.1" });
    }
    assert.deepEqual(q.stalledBinds(), []);
  });

  it("**待办数字和列表长度必须一致**", () => {
    /*
     * 两条查询迟早会对不上,而对不上的表现是
     * 「待办上写着 12、点进去只有 3 条」—— 那时候人不会怀疑数字,
     * 只会觉得这一页坏了。
     */
    const now = Date.now();
    for (let i = 0; i < 2; i++) makeBind({ createdAt: now - 900_000 - i, expiresAt: now, ip: "1.1.1.1" });
    for (let i = 0; i < 2; i++) makeBind({ createdAt: now - 800_000 - i, expiresAt: now, ip: "2.2.2.2" });
    makeBind({ createdAt: now - 700_000, expiresAt: now, ip: "3.3.3.3" });

    assert.equal(q.bindQueueSize(), q.stalledBinds().length);
    assert.equal(q.bindQueueSize(), 2, "只取过一次的那个 IP 被算进去了");
  });
});

describe("已经绑过的微信号", () => {
  it("查得出绑在哪个账号上", () => {
    dbm.db
      .insert(schema.users)
      .values({ id: "01USER1000000000000000000", wxId: WX, status: "active" })
      .run();
    assert.equal(q.boundAccountOf(WX), "01USER1000000000000000000");
  });

  it("没绑过就是 null", () => {
    assert.equal(q.boundAccountOf("wxid_nobody"), null);
  });

  it("绑过之后活跃度照样查得到 —— 两件事互不相干", () => {
    joinGroup(CONV_A, { messages: 7 });
    dbm.db
      .insert(schema.users)
      .values({ id: "01USER1000000000000000000", wxId: WX, status: "active" })
      .run();
    assert.equal(q.applicantActivity(WX).messages, 7);
  });
});

describe("上游挂了的时候", () => {
  it("**不显示成「没有待处理的申请」** —— 那会让人以为处理完了", async () => {
    // NEKOBOT_API_KEY 是假的，请求必然失败
    const result = await q.pendingFriendRequests(5);
    assert.deepEqual(result.rows, []);
    assert.ok(result.error, "上游失败了却没有任何提示");
    assert.match(result.error!, /拉不到好友申请列表/);
  });
});

describe("清理", () => {
  it("被作废的绑定请求要从队列里消失", () => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      dbm.db
        .insert(schema.bindCodes)
        .values({
          code: "123456",
          sessionNonce: `n${i}`,
          createdAt: now - 600_000 - i,
          expiresAt: now + 300_000,
          issuedIp: "1.1.1.1",
          status: "revoked",
        })
        .run();
    }

    /*
     * 作废之后它仍然 matchedAt 为空、仍在 24 小时内 ——
     * 所以查询必须自己把 revoked 排掉，不然点了「作废」之后
     * 那一条还在原地，人会以为没生效。
     */
    const rows = q.stalledBinds();
    assert.deepEqual(rows, [], "作废之后还留在队列里");
  });
});
