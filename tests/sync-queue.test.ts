import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

/**
 * 手动触发的同步队列。
 *
 * **没有消费者的话，后台那个「立即同步」按钮是个谎** ——
 * 排进去的 pending 永远不会被执行，而且「有任务在跑就不能再触发」
 * 的判定会把 pending 也算进去，点一次之后所有触发都被永久挡住。
 *
 * 这组测试锁的就是这条链路：排队 → 取走 → 收尾。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-queue-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

type Mod = typeof import("@/lib/sync/queue");
type DbModule = typeof import("@/lib/db");
type SchemaModule = typeof import("@/lib/db/schema");

let mod: Mod;
let dbm: DbModule;
let schema: SchemaModule;

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  mod = await import("@/lib/sync/queue");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  dbm.db.delete(schema.syncJobs).run();
});

function job(over: Record<string, unknown> = {}) {
  return dbm.db
    .insert(schema.syncJobs)
    .values({ kind: "messages", status: "pending", triggeredBy: "admin", ...over })
    .returning({ id: schema.syncJobs.id })
    .get().id;
}

describe("取走待执行的任务", () => {
  it("取得到排队的任务", () => {
    job();
    const claimed = mod.claimPending(NOW);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].kind, "messages");
  });

  it("**取走的同时就标成 running** —— 中间不留窗口", () => {
    // 留窗口的话两个进程会同时取到同一批
    const id = job();
    mod.claimPending(NOW);
    assert.equal(dbm.db.select().from(schema.syncJobs).where(eq(schema.syncJobs.id, id)).get()!.status, "running");
  });

  it("**第二次取不到已经被取走的**", () => {
    job();
    assert.equal(mod.claimPending(NOW).length, 1);
    assert.equal(mod.claimPending(NOW).length, 0);
  });

  it("按排队顺序取", () => {
    job({ scope: "first", createdAt: NOW - 2 * MINUTE });
    job({ scope: "second", createdAt: NOW - MINUTE });

    const claimed = mod.claimPending(NOW);
    assert.equal(claimed[0].scope, "first");
  });

  it("没有排队时返回空数组，且不做任何写入", () => {
    assert.deepEqual(mod.claimPending(NOW), []);
  });

  it("已完成的任务不会被重新取走", () => {
    job({ status: "success" });
    job({ status: "failed" });
    assert.equal(mod.claimPending(NOW).length, 0);
  });

  it("带出重试次数与触发人", () => {
    job({ retryCount: 2, triggeredByUser: "u_admin" });
    const claimed = mod.claimPending(NOW);
    assert.equal(claimed[0].retryCount, 2);
    assert.equal(claimed[0].triggeredByUser, "u_admin");
  });
});

describe("僵死任务", () => {
  it("**进程崩溃留下的 running 会被清掉**", () => {
    // 不清的话它们一直挂着，把「有任务在跑就不能再触发」的判定堵死
    const id = job({ status: "running", startedAt: NOW - 60 * MINUTE });
    mod.claimPending(NOW);

    const row = dbm.db.select().from(schema.syncJobs).where(eq(schema.syncJobs.id, id)).get()!;
    assert.equal(row.status, "failed");
    assert.match(row.error!, /中断/);
  });

  it("刚开始跑的不会被误清", () => {
    const id = job({ status: "running", startedAt: NOW - MINUTE });
    mod.claimPending(NOW);
    assert.equal(dbm.db.select().from(schema.syncJobs).where(eq(schema.syncJobs.id, id)).get()!.status, "running");
  });

  it("**僵死判定与清理共用同一把尺**", async () => {
    /*
     * 线上真的发生过：`npm run sync | head` 里 head 先退出，
     * 同步进程被 SIGPIPE 杀掉，running 那一行永远等不到收尾。
     * 两处各写一个阈值的话，界面会被一具尸体锁死触发按钮，
     * 而清理逻辑却认为它还活着。
     */
    job({ status: "running", startedAt: NOW - 60 * MINUTE });

    const { runningJobs } = await import("@/lib/admin/groups");
    assert.equal(runningJobs(NOW), 0, "尸体不该挡住触发");

    mod.claimPending(NOW);
    assert.equal(runningJobs(NOW), 0, "清理之后仍然是 0");
  });

  it("没有 startedAt 的 running 是坏数据，按尸体处理", () => {
    assert.equal(mod.isStaleRunning({ status: "running", startedAt: null }, NOW), true);
  });

  it("pending 不算尸体 —— 它只是还没被取走", () => {
    assert.equal(mod.isStaleRunning({ status: "pending", startedAt: null }, NOW), false);
  });
});

describe("收尾", () => {
  it("成功时记录拉取与写入数", () => {
    const id = job();
    mod.claimPending(NOW);
    mod.completeJob(id, { fetched: 100, written: 42 }, NOW + MINUTE);

    const row = dbm.db.select().from(schema.syncJobs).where(eq(schema.syncJobs.id, id)).get()!;
    assert.equal(row.status, "success");
    assert.equal(row.itemsFetched, 100);
    assert.equal(row.itemsWritten, 42);
    assert.equal(row.durationMs, MINUTE);
  });

  it("失败时保留错误原文 —— 那是排查的唯一线索", () => {
    const id = job();
    mod.claimPending(NOW);
    mod.completeJob(id, { fetched: 0, written: 0, error: "ECONNREFUSED 127.0.0.1:8090" }, NOW);

    const row = dbm.db.select().from(schema.syncJobs).where(eq(schema.syncJobs.id, id)).get()!;
    assert.equal(row.status, "failed");
    assert.match(row.error!, /ECONNREFUSED/);
  });

  it("**收尾之后队列不再堵着** —— 触发判定能重新放行", async () => {
    const id = job();
    mod.claimPending(NOW);
    mod.completeJob(id, { fetched: 1, written: 1 }, NOW);

    const { runningJobs } = await import("@/lib/admin/groups");
    assert.equal(runningJobs(), 0);
  });
});

describe("折叠重复触发", () => {
  it("**同一个目标排了五次只跑一次**", () => {
    // 管理员连点五下是很常见的，跑五遍只会让上游多挨五次请求
    const jobs = Array.from({ length: 5 }, () => ({
      id: `j${Math.random()}`,
      kind: "messages",
      scope: "g1",
      retryCount: 0,
      triggeredByUser: null,
    }));

    const collapsed = mod.collapseJobs(jobs);
    assert.equal(collapsed.size, 1);
    assert.equal(collapsed.get("messages:g1")!.length, 5, "折叠掉的也要留着，收尾时一起标完成");
  });

  it("不同目标分开跑", () => {
    const collapsed = mod.collapseJobs([
      { id: "a", kind: "messages", scope: "g1", retryCount: 0, triggeredByUser: null },
      { id: "b", kind: "messages", scope: "g2", retryCount: 0, triggeredByUser: null },
      { id: "c", kind: "members", scope: null, retryCount: 0, triggeredByUser: null },
    ]);
    assert.equal(collapsed.size, 3);
  });

  it("scope 为空与不为空是不同目标", () => {
    const collapsed = mod.collapseJobs([
      { id: "a", kind: "messages", scope: null, retryCount: 0, triggeredByUser: null },
      { id: "b", kind: "messages", scope: "g1", retryCount: 0, triggeredByUser: null },
    ]);
    assert.equal(collapsed.size, 2);
  });

  it("空队列折叠出空表", () => {
    assert.equal(mod.collapseJobs([]).size, 0);
  });
});

describe("端到端：排队不会把自己堵死", () => {
  it("**排队 → 取走 → 收尾之后还能再触发**", async () => {
    const { runningJobs } = await import("@/lib/admin/groups");

    const id = job();
    assert.equal(runningJobs(), 1, "排队后触发会被挡住，这是对的");

    const claimed = mod.claimPending(NOW);
    assert.equal(claimed.length, 1);

    mod.completeJob(id, { fetched: 5, written: 5 }, NOW);
    assert.equal(runningJobs(), 0, "收尾后必须放行 —— 否则点一次就永久挡死");
  });
});
