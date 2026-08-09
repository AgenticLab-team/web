import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it, mock } from "node:test";

import { and, eq } from "drizzle-orm";

/**
 * 告警的落库与投递。
 *
 * 这组测试锁三件事：
 *   ① 一次故障只留一条记录 —— 每轮探测插一行的话，
 *      两小时的故障会留下二十四条，而真正要知道的只有「什么时候开始的」
 *   ② 发送失败要记下来 —— 让「没收到告警」和「告警发失败了」分得开
 *   ③ 上游挂了的时候微信发不出去，这一点必须**如实记录**而不是假装发过了
 */

const tmp = mkdtempSync(join(tmpdir(), "al-alert-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

type DbModule = typeof import("@/lib/db");
type SchemaModule = typeof import("@/lib/db/schema");
type DispatchModule = typeof import("@/lib/alerts/dispatch");
type HealthReport = import("@/lib/health").HealthReport;

let dbm: DbModule;
let schema: SchemaModule;
let dispatch: DispatchModule;
let client: typeof import("@/lib/nekobot/client");

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

/** 收到的微信消息 —— 用来断言「到底发出去了没有」 */
let sent: Array<{ to: string; text: string }> = [];
let sendFails = false;

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });

  client = await import("@/lib/nekobot/client");
  mock.method(client.nekobot, "sendText", async (to: string, text: string) => {
    if (sendFails) throw new Error("upstream 502");
    sent.push({ to, text });
    return { ok: true } as never;
  });

  dispatch = await import("@/lib/alerts/dispatch");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  dbm.db.delete(schema.alerts).run();
  dbm.db.delete(schema.systemHealth).run();
  dbm.db.delete(schema.userRoles).run();
  dbm.db.delete(schema.users).run();
  dbm.db.delete(schema.roles).run();
  sent = [];
  sendFails = false;
});

/** 造一个能收告警的 owner */
function seedOwner(wxId: string | null = "wxid_admin") {
  const role = dbm.db
    .insert(schema.roles)
    .values({ key: "owner", name: "站长" })
    .returning({ id: schema.roles.id })
    .get();
  const user = dbm.db
    .insert(schema.users)
    .values({ wxId, wxNickname: "站长" })
    .returning({ id: schema.users.id })
    .get();
  dbm.db.insert(schema.userRoles).values({ userId: user.id, roleId: role.id }).run();
  return user.id;
}

/** 往健康表里塞连续 N 轮的故障记录 */
function seedHealth(
  component: "upstream_api" | "frp_tunnel" | "db" | "disk",
  status: "ok" | "degraded" | "down",
  rounds: number,
  endAt = NOW,
) {
  for (let i = rounds - 1; i >= 0; i--) {
    dbm.db
      .insert(schema.systemHealth)
      .values({ component, status, detail: `${component} ${status}`, checkedAt: endAt - i * 5 * MINUTE })
      .run();
  }
}

function report(
  component: string,
  status: "ok" | "degraded" | "down",
  detail = "",
): HealthReport {
  return { component, status, detail } as HealthReport;
}

function firing(component: string) {
  return dbm.db
    .select()
    .from(schema.alerts)
    .where(and(eq(schema.alerts.component, component), eq(schema.alerts.state, "firing")))
    .all();
}

describe("落库", () => {
  it("持续故障才建告警，一次抖动不留痕", async () => {
    seedOwner();
    seedHealth("db", "down", 1);
    const r = await dispatch.checkAndDispatch([report("db", "down", "打不开")], NOW);
    assert.equal(r.fired, 0);
    assert.equal(firing("db").length, 0);
  });

  it("挂够久建一条，之后每轮探测不再新增", async () => {
    seedOwner();
    // 5 分钟一轮，塞 3 轮 = 连续 10 分钟不正常，超过 db 的 2 分钟线
    seedHealth("db", "down", 3);

    const first = await dispatch.checkAndDispatch([report("db", "down", "打不开")], NOW);
    assert.equal(first.fired, 1);

    const second = await dispatch.checkAndDispatch([report("db", "down", "打不开")], NOW + MINUTE);
    assert.equal(second.fired, 0, "同一次故障不该再插一条");

    const rows = firing("db");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].firstSeenAt, NOW - 10 * MINUTE, "开始时间要指向故障真正开始的那一刻");
    assert.equal(rows[0].lastSeenAt, NOW + MINUTE, "最后一次看到要跟着走");
  });

  it("数据库层面挡住同组件两条 firing —— 索引不是摆设", () => {
    const values = {
      component: "db" as const,
      severity: "critical" as const,
      title: "数据库中断",
      state: "firing" as const,
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    };
    dbm.db.insert(schema.alerts).values(values).run();
    assert.throws(() => dbm.db.insert(schema.alerts).values(values).run(), /UNIQUE/i);
  });

  it("已恢复的不占坑 —— 同一组件可以再次报警", async () => {
    seedOwner();
    seedHealth("db", "down", 3);
    await dispatch.checkAndDispatch([report("db", "down")], NOW);

    // 恢复
    seedHealth("db", "ok", 1, NOW + MINUTE);
    const resolved = await dispatch.checkAndDispatch([report("db", "ok", "正常")], NOW + MINUTE);
    assert.equal(resolved.resolved, 1);
    assert.equal(firing("db").length, 0);

    // 再挂一次，应该能重新建
    seedHealth("db", "down", 3, NOW + 60 * MINUTE);
    const again = await dispatch.checkAndDispatch([report("db", "down")], NOW + 60 * MINUTE);
    assert.equal(again.fired, 1);
    assert.equal(dbm.db.select().from(schema.alerts).all().length, 2);
  });
});

describe("投递", () => {
  it("发给绑定了微信的 owner，带上严重程度和排查提示", async () => {
    seedOwner("wxid_admin");
    seedHealth("db", "down", 3);
    const r = await dispatch.checkAndDispatch([report("db", "down", "quick_check 失败")], NOW);

    assert.equal(r.delivered, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "wxid_admin");
    assert.match(sent[0].text, /严重/);
    assert.match(sent[0].text, /数据库/);
    assert.match(sent[0].text, /WAL/, "没告诉人先查什么");
  });

  it("恢复也发一条 —— 不然人会一直手动去查", async () => {
    seedOwner();
    seedHealth("db", "down", 3);
    await dispatch.checkAndDispatch([report("db", "down")], NOW);
    sent = [];

    seedHealth("db", "ok", 1, NOW + MINUTE);
    await dispatch.checkAndDispatch([report("db", "ok", "完整性检查通过")], NOW + MINUTE);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /已恢复/);
  });

  it("发送失败要记在 notifyError 上 —— 「没收到」和「发失败了」是两回事", async () => {
    seedOwner();
    seedHealth("db", "down", 3);
    sendFails = true;

    const r = await dispatch.checkAndDispatch([report("db", "down")], NOW);
    assert.equal(r.fired, 1, "发不出去也要落库");
    assert.equal(r.failed, 1);

    const row = firing("db")[0];
    assert.equal(row.notifiedAt, null);
    assert.match(row.notifyError ?? "", /502/);
    assert.equal(dispatch.undeliveredAlerts().length, 1);
  });

  it("发送失败不会更新 notifiedAt —— 否则重提醒会从一次没送到的通知开始算", async () => {
    seedOwner();
    seedHealth("db", "down", 3);
    sendFails = true;
    await dispatch.checkAndDispatch([report("db", "down")], NOW);

    // 一小时后（超过 db 的重提醒间隔）应该还会再试一次
    sendFails = false;
    seedHealth("db", "down", 3, NOW + 61 * MINUTE);
    const r = await dispatch.checkAndDispatch([report("db", "down")], NOW + 61 * MINUTE);
    assert.equal(r.renotified, 1);
    assert.equal(sent.length, 1);
    assert.equal(firing("db")[0].notifyError, null, "这次发成功了，错误要清掉");
  });

  it("没有绑定微信的管理员时如实记录，而不是静默成功", async () => {
    seedOwner(null);
    seedHealth("db", "down", 3);
    const r = await dispatch.checkAndDispatch([report("db", "down")], NOW);
    assert.equal(r.failed, 1);
    assert.match(firing("db")[0].notifyError ?? "", /管理员/);
  });
});

describe("上游 —— 报信的人和出事的人是同一个", () => {
  it("上游断了的告警照样落库，但不假装发得出去", async () => {
    seedOwner();
    seedHealth("frp_tunnel", "down", 3);

    const r = await dispatch.checkAndDispatch([report("frp_tunnel", "down", "隧道不通")], NOW);
    assert.equal(r.fired, 1);
    assert.equal(r.delivered, 0);
    assert.equal(sent.length, 0, "不该硬发 —— 发送本身也走上游");
    assert.match(firing("upstream")[0].notifyError ?? "", /外部监控/);
  });

  it("隧道断了之后 upstream_api 那一行是旧的，不能被当成「上游正常」", async () => {
    seedOwner();
    // 断之前上游是好的，断之后所有失败都记在 frp_tunnel 名下
    seedHealth("upstream_api", "ok", 2, NOW - 60 * MINUTE);
    seedHealth("frp_tunnel", "down", 3, NOW);

    const r = await dispatch.checkAndDispatch([report("frp_tunnel", "down", "隧道不通")], NOW);
    assert.equal(r.fired, 1, "上一轮的 ok 记录不该把这次故障抵消掉");
    assert.equal(firing("upstream").length, 1);
  });

  it("两个探测归到同一条告警 —— 归因在故障期间换来换去也只报一次", async () => {
    seedOwner();
    seedHealth("frp_tunnel", "down", 3);
    await dispatch.checkAndDispatch([report("frp_tunnel", "down")], NOW);

    // 隧道通了但接口继续报错 —— 归因变了，对人来说还是同一件事
    seedHealth("upstream_api", "down", 1, NOW + 5 * MINUTE);
    const r = await dispatch.checkAndDispatch([report("upstream_api", "down")], NOW + 5 * MINUTE);
    assert.equal(r.fired, 0);
    assert.equal(firing("upstream").length, 1);
  });

  it("一个探测正常掩盖不了另一个断了", async () => {
    seedOwner();
    seedHealth("frp_tunnel", "down", 3);
    const r = await dispatch.checkAndDispatch(
      [report("upstream_api", "ok"), report("frp_tunnel", "down")],
      NOW,
    );
    assert.equal(r.fired, 1);
    assert.equal(firing("upstream")[0].severity, "critical");
  });
});

describe("多组件同轮", () => {
  it("一轮里各组件互不影响", async () => {
    seedOwner();
    seedHealth("db", "down", 3);
    seedHealth("disk", "degraded", 1);

    const r = await dispatch.checkAndDispatch(
      [report("db", "down", "打不开"), report("disk", "degraded", "91%")],
      NOW,
    );
    assert.equal(r.fired, 1, "磁盘才降级 10 分钟，还没到 30 分钟的线");
    assert.equal(firing("db").length, 1);
    assert.equal(firing("disk").length, 0);
  });

  it("列表按最近的故障排前面，并带上可读的组件名", async () => {
    seedOwner();
    seedHealth("db", "down", 3);
    await dispatch.checkAndDispatch([report("db", "down")], NOW);
    seedHealth("disk", "down", 20, NOW + 120 * MINUTE);
    await dispatch.checkAndDispatch([report("disk", "down", "满了")], NOW + 120 * MINUTE);

    const list = dispatch.listAlerts();
    assert.equal(list.length, 2);
    assert.equal(list[0].component, "disk");
    assert.equal(list[0].componentLabel, "磁盘");
  });
});
