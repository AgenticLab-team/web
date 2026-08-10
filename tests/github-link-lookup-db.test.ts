import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * 资源库里的 GitHub 链接：直接问 GitHub，别问模型 —— 接上真库之后。
 *
 * ═════════════════════════════════════════
 * 这里守的是「失败怎么记」
 * ═════════════════════════════════════════
 *
 * 成功那条路很短，出不了什么事。真正会出事的是失败：
 *
 *   · 把**故障**记成结论（记了 factCheckedAt）—— 一次网络抖动会让
 *     这一批链接**永远**不再被问一次，而且没有任何地方看得出来。
 *     资源库那边踩过一模一样的坑，注释还在 enrich.ts 上。
 *   · 把**结论**当成故障（不记）—— 一个删掉的仓库会被无限重问，
 *     每一轮整理都拿它去撞一次 404，配额白花在同一条链接上。
 *
 * 两个方向都不会报错、都不会崩，只会安静地跑偏。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-ghlookup-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

let dbm: typeof import("@/lib/db");
let schema: typeof import("@/lib/db/schema");
let lookup: typeof import("@/lib/github/link-lookup");

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  lookup = await import("@/lib/github/link-lookup");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  dbm.db.delete(schema.links).run();
  fetcher = async () => ({});
});

let seq = 0;
/**
 * `domain` 默认填 github.com —— **故意的**。
 *
 * SQL 那一层用 domain 做预筛，但它不是判定；判定是 parseGithubUrl。
 * 测试里如实按 URL 填 domain 的话，钓鱼那条会被预筛顺手挡掉，
 * 于是**那条测试其实什么都没验到** —— 它会在解析层被改坏之后依然变绿。
 * 所以这里让预筛一律放行，把每一条都逼到真正的那道闸前面。
 */
function addLink(url: string, domain = "github.com") {
  const id = `link_${++seq}`;
  dbm.db
    .insert(schema.links)
    .values({
      id,
      urlKey: `${url}#${id}`,
      url,
      domain,
      title: url,
      firstSharedAt: 1,
      lastSharedAt: 1,
    })
    .run();
  return id;
}

const rowOf = (id: string) =>
  dbm.db.select().from(schema.links).all().find((l) => l.id === id)!;

/** 这一轮让 GitHub「回答」什么 —— 注入进去，而不是打桩 */
let fetcher: (path: string) => Promise<Record<string, unknown>>;
const stub = (impl: (path: string) => Promise<Record<string, unknown>>) => {
  fetcher = impl;
};
const run = () => lookup.lookupGithubLinks({ fetcher: (p) => fetcher(p) });

function apiError(status: number) {
  const e = new Error(`GitHub 返回 ${status}`) as Error & { status: number };
  e.status = status;
  return e;
}

describe("问到了", () => {
  it("写进 fact_* 而**不是** ai_*", async () => {
    /*
     * ai_* 那两列分开存就是为了让界面说清「哪一条是机器写的」。
     * 把 GitHub 的权威回答塞进去，那句提示本身就成了假话。
     */
    const id = addLink("https://github.com/vercel/next.js");
    stub(async () => ({
      description: "The React Framework",
      language: "JavaScript",
      stargazers_count: 1234,
    }));

    const report = await run();
    assert.equal(report.written, 1);

    const row = rowOf(id);
    assert.equal(row.factTitle, "vercel/next.js");
    assert.match(row.factSummary!, /The React Framework/);
    assert.equal(row.factSource, "github");
    assert.ok(row.factCheckedAt);
    assert.equal(row.aiTitle, null, "写到 ai_title 上去了");
    assert.equal(row.aiSummary, null);
  });

  it("**不是 GitHub 的链接一条都不碰** —— 就算预筛放它进来了", async () => {
    const id = addLink("https://example.com/a/b");
    const calls: string[] = [];
    stub(async (p) => {
      calls.push(p);
      return {};
    });

    const report = await run();
    assert.deepEqual(calls, []);
    assert.equal(report.scanned, 0);
    assert.equal(rowOf(id).factCheckedAt, null);
  });

  it("**长得像 github.com 的也不碰** —— 解析层挡住了，这里确认它真的接上了", async () => {
    const id = addLink("https://github.com.evil.com/a/b");
    stub(async () => ({ description: "钓鱼" }));
    await run();
    assert.equal(rowOf(id).factTitle, null);
  });

  it("commit 链接不去问 —— 问一趟拿不回更多", async () => {
    addLink(`https://github.com/a/b/commit/${"0".repeat(40)}`);
    const calls: string[] = [];
    stub(async (p) => {
      calls.push(p);
      return {};
    });
    await run();
    assert.deepEqual(calls, []);
  });

  it("**别的域名连翻都不翻** —— 否则 limit 数的是行数不是 GitHub 链接数", async () => {
    /*
     * 线上五百多条链接里 GitHub 只占三十几条。不在 SQL 里先筛掉，
     * limit 30 实际只碰得上一两条 GitHub 链接，跑二十轮也补不完 ——
     * 而每一轮的输出都显示「成功」，没有任何地方看得出没跑到。
     */
    for (let i = 0; i < 20; i++) addLink(`https://example.com/x${i}`, "example.com");
    addLink("https://github.com/a/b");

    const calls: string[] = [];
    stub(async (p) => {
      calls.push(p);
      return { description: "x" };
    });

    const report = await lookup.lookupGithubLinks({ fetcher: (p) => fetcher(p), limit: 5 });
    assert.deepEqual(calls, ["/repos/a/b"], "limit 被那 20 条不相干的链接吃掉了");
    assert.equal(report.written, 1);
  });

  it("问过一次之后不再问第二次", async () => {
    addLink("https://github.com/a/b");
    stub(async () => ({ description: "x" }));
    await run();

    const calls: string[] = [];
    stub(async (p) => {
      calls.push(p);
      return {};
    });
    await run();
    assert.deepEqual(calls, [], "同一条又问了一遍");
  });
});

describe("**404 是结论，记下来别再问**", () => {
  for (const status of [404, 451]) {
    it(`${status}`, async () => {
      const id = addLink("https://github.com/gone/repo");
      stub(async () => {
        throw apiError(status);
      });

      const report = await run();
      assert.equal(report.gone, 1);

      const row = rowOf(id);
      assert.ok(row.factCheckedAt, "没记下来 —— 这条会被无限重问");
      assert.equal(row.factTitle, null, "什么都没问到却写了标题");
    });
  }

  it("记过之后确实不再问", async () => {
    addLink("https://github.com/gone/repo");
    stub(async () => {
      throw apiError(404);
    });
    await run();

    const calls: string[] = [];
    stub(async (p) => {
      calls.push(p);
      throw apiError(404);
    });
    await run();
    assert.deepEqual(calls, []);
  });
});

describe("**故障不能记 —— 记了就是永久放弃这一条**", () => {
  for (const [what, status] of [
    ["网络错误", 0],
    ["限流", 403],
    ["请求太多", 429],
    ["GitHub 自己挂了", 500],
    ["网关超时", 504],
  ] as const) {
    it(what, async () => {
      const id = addLink("https://github.com/a/b");
      stub(async () => {
        throw apiError(status);
      });

      const report = await run();
      assert.equal(report.failed, 1);
      assert.equal(
        rowOf(id).factCheckedAt,
        null,
        `${what} 被记成了结论 —— 这条链接从此再也不会被问`,
      );
    });
  }

  it("**403 尤其不能当成「没有」** —— 它几乎总是配额用完", async () => {
    /*
     * 当成 404 处理的话，配额恢复之后这一整批链接也不会再被问 ——
     * 而「配额用完」恰恰是会一次影响一大批的那种故障。
     */
    const ids = [addLink("https://github.com/a/b"), addLink("https://github.com/c/d")];
    stub(async () => {
      throw apiError(403);
    });
    await run();
    for (const id of ids) assert.equal(rowOf(id).factCheckedAt, null);
  });

  it("**限流之后当轮就停** —— 继续跑只是把剩下的每条都换成一次超时", async () => {
    for (let i = 0; i < 5; i++) addLink(`https://github.com/a/b${i}`);
    let calls = 0;
    stub(async () => {
      calls++;
      throw apiError(403);
    });

    const report = await run();
    assert.equal(calls, 1, `限流之后还问了 ${calls} 次`);
    assert.ok(report.notes.some((n) => n.includes("限流")));
  });

  it("**普通失败不停** —— 一条坏的不该挡住后面所有的", async () => {
    addLink("https://github.com/a/bad");
    addLink("https://github.com/a/good");
    let calls = 0;
    stub(async () => {
      calls++;
      if (calls === 1) throw apiError(500);
      return { description: "好的" };
    });

    const report = await run();
    assert.equal(calls, 2);
    assert.equal(report.written, 1);
    assert.equal(report.failed, 1);
  });

  it("回来了但字段读不出来 —— 也是故障，下次还该再试", async () => {
    const id = addLink("https://github.com/a/b/issues/1");
    // issue 没有 title 就给不出事实
    stub(async () => ({ state: "open" }));

    const report = await run();
    assert.equal(report.failed, 1);
    assert.equal(rowOf(id).factCheckedAt, null);
  });
});

describe("有权威事实之后就别问模型了", () => {
  it("有了就算数", () => {
    assert.equal(
      lookup.hasAuthoritativeFacts({ factTitle: "a/b", factSummary: "x" }),
      true,
    );
  });

  it("**只有标题没有简介不算** —— 界面上那一行还是空的", () => {
    assert.equal(lookup.hasAuthoritativeFacts({ factTitle: "a/b", factSummary: null }), false);
  });

  it("问过但没问到的不算 —— 那条还该交给模型试试", () => {
    assert.equal(lookup.hasAuthoritativeFacts({ factTitle: null, factSummary: null }), false);
  });
});
