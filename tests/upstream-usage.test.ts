import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { callerRole, normalizeEndpoint } from "@/lib/upstream/usage-rules";
import { stripComments as strip } from "./_source";

/**
 * 上游调用的账。
 *
 * ─────────────────────────────────────────
 * 这张表建了 763 天，0 行
 * ─────────────────────────────────────────
 *
 * `api_usage` 顶上写着「上游有配额，调用量要能看、能定位是谁打的」——
 * 而没有任何一处往里写过。于是「上游最近是不是在报错」这个问题，
 * 站里答不上来：健康探测只知道**此刻**通不通，
 * 一次十分钟前的 502 潮它完全看不见。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

describe("**端点要归一化 —— 不然会把成员 id 存进这张表**", () => {
  /*
   * 两个理由，第二个更要紧：
   *
   * ① 基数会炸：每个人每次查询都是一个新字符串，聚合出来
   *    几万行各不相同的「端点」，什么也看不出来。
   * ② 路径里带着 wxId 和会话 id —— 一张用来看调用量的运维表，
   *    不该顺带攒下一份「谁在什么时候被谁查了」。
   *
   * 第二条比第一条重要：基数炸了只是难看，存了 id 是隐私问题，
   * 而且不会有人注意到。
   */
  it("群 id 换成 :id", () => {
    assert.equal(
      normalizeEndpoint("/groups/12345678@chatroom/leaderboard?days=7"),
      "/groups/:id/leaderboard",
    );
    assert.equal(normalizeEndpoint("/groups/12345678@chatroom/members"), "/groups/:id/members");
  });

  it("**wxId 换成 :id**", () => {
    assert.equal(normalizeEndpoint("/users/wxid_abc123def/groups?days=30"), "/users/:id/groups");
    assert.equal(normalizeEndpoint("/users/wxid_abc123def"), "/users/:id");
  });

  it("好友申请里的 wxId 也一样", () => {
    assert.equal(
      normalizeEndpoint("/friend-requests/wxid_xyz/accept"),
      "/friend-requests/:id/accept",
    );
  });

  it("**`/users/search` 不能被误当成一个 wxId**", () => {
    // 它是固定端点，归一化掉的话所有搜索都混进 /users/:id 里
    assert.equal(normalizeEndpoint("/users/search?q=张三&limit=20"), "/users/search");
  });

  it("**查询串一律丢掉** —— 里面是关键词、时间范围、分页，全是内容", () => {
    assert.equal(normalizeEndpoint("/messages?keyword=台风&limit=500"), "/messages");
    assert.equal(normalizeEndpoint("/friend-requests?pending_only=true"), "/friend-requests");
  });

  it("固定端点原样保留", () => {
    for (const p of ["/whoami", "/stats/overview", "/send/quota", "/send/text", "/conversations"]) {
      assert.equal(normalizeEndpoint(p), p);
    }
  });

  it("**归一化之后不该再剩下任何看起来像 id 的东西**", () => {
    /*
     * 这一条是兜底：上游哪天加一个新的带 id 端点，
     * 上面那几条规则不认识它，而这条会红。
     */
    const samples = [
      "/groups/12345678@chatroom/leaderboard",
      "/users/wxid_abc123def/groups",
      "/friend-requests/wxid_xyz/accept",
    ];
    for (const s of samples) {
      const out = normalizeEndpoint(s);
      assert.equal(/wxid_|@chatroom/.test(out), false, `${s} → ${out} 里还带着 id`);
    }
  });
});

describe("谁打的", () => {
  it("同步、探测各认各的", () => {
    assert.equal(callerRole("/home/ubuntu/agenticlab/scripts/sync.ts"), "sync");
    assert.equal(callerRole("/home/ubuntu/agenticlab/scripts/health.ts"), "health");
  });

  it("网页服务算 web", () => {
    assert.equal(callerRole("/app/node_modules/next/dist/bin/next"), "web");
    assert.equal(callerRole(""), "web");
  });
});

describe("**记账不能拖垮真实调用**", () => {
  const usage = strip(src("lib/upstream/usage.ts"));

  it("写入包在 try/catch 里", () => {
    /*
     * 这是一张运维表，而它的写入路径上有磁盘、有锁、
     * 有可能正在被裁剪。一次记账异常把同步任务打断，
     * 是拿真东西换假东西。
     */
    assert.match(usage, /try \{[\s\S]*?db\s*\n?\s*\.insert\(apiUsage\)[\s\S]*?\} catch/);
  });

  it("错误原文截断 —— 上游会把整个 HTML 错误页塞回来", () => {
    assert.match(usage, /slice\(0, 300\)/);
  });
});

describe("**记的是每一次 HTTP 尝试，不是每个逻辑调用**", () => {
  const client = strip(src("lib/nekobot/client.ts"));

  it("记账在重试循环**里面**", () => {
    /*
     * 一次「重试两次才成功」，上游那侧确实收了三个请求、
     * 扣了三次配额、报了两次错。按逻辑调用记的话它会显示成
     * 一次干净的 200 —— 而那正好把「上游最近在报错」这件事抹掉。
     */
    const loop = client.slice(client.indexOf("for (let attempt"));
    assert.match(loop, /const startedAt = Date\.now\(\)/);
    assert.match(loop, /recordApiCall\(/);
  });

  it("每次尝试只记一行 —— 有 logged 闸门", () => {
    // 4xx 那一支先 log 再 throw，然后被外层 catch 接住；没有闸门会记两次
    assert.match(client, /let logged = false/);
    assert.match(client, /if \(logged\) return;/);
  });

  it("**没连上时状态码留空** —— 和 500 是两回事", () => {
    // 一个去查隧道，一个去查上游服务；混在一起看的人得不到指向
    assert.match(client, /log\(undefined, `上游超时/);
    assert.match(client, /log\(undefined, `连接上游失败/);
  });

  it("**200 但正文不是 JSON 记成失败**，不记成成功", () => {
    assert.match(client, /log\(response\.status, "上游返回的不是合法 JSON"\)/);
  });

  it("成功那一支在解析之后才记 —— 解析失败的不能算成功", () => {
    assert.match(client, /const parsed = \(await response\.json\(\)\) as T;\s*\n\s*log\(response\.status\);/);
  });
});

/* ───────────────────────────────────────────────────────────────
 * 真数据库
 * ─────────────────────────────────────────────────────────────── */

describe("真库", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "al-usage-"));
  process.env.DB_PATH = join(tmp, "test.db");
  process.env.NEKOBOT_API_KEY = "nk_test";

  const dbm = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  const mod = await import("@/lib/upstream/usage");

  after(() => rmSync(tmp, { recursive: true, force: true }));

  const NOW = 1_800_000_000_000;
  const row = (over: Record<string, unknown> = {}) =>
    dbm.db
      .insert(schema.apiUsage)
      .values({
        endpoint: "/messages",
        statusCode: 200,
        latencyMs: 100,
        triggeredBy: "sync",
        createdAt: NOW - 60_000,
        ...over,
      })
      .run();

  const reset = () => dbm.db.delete(schema.apiUsage).run();

  it("记一笔进得去，而且端点是归一化过的", () => {
    reset();
    mod.recordApiCall({ path: "/users/wxid_secret/groups?days=7", status: 200, latencyMs: 42 });
    const [r] = dbm.db.select().from(schema.apiUsage).all();
    assert.equal(r.endpoint, "/users/:id/groups");
    assert.equal(r.latencyMs, 42);
  });

  it("**库里不该出现 wxId**", () => {
    reset();
    mod.recordApiCall({ path: "/users/wxid_secret/groups", status: 200, latencyMs: 1 });
    mod.recordApiCall({ path: "/groups/9999@chatroom/members", status: 500, latencyMs: 1 });
    const all = JSON.stringify(dbm.db.select().from(schema.apiUsage).all());
    assert.equal(all.includes("wxid_secret"), false);
    assert.equal(all.includes("@chatroom"), false);
  });

  it("**没连上和 4xx/5xx 分开统计**", () => {
    reset();
    row({ statusCode: 200 });
    row({ statusCode: 500 });
    row({ statusCode: 404 });
    row({ statusCode: null });
    const s = mod.usageSummary(24, NOW);
    assert.equal(s.calls, 4);
    assert.equal(s.errors, 3, "没连上也算失败");
    assert.equal(s.unreachable, 1, "但它单独还要能数出来");
  });

  it("**中位数不被一次超时带偏，而 P95 必须看得见它**", () => {
    /*
     * 这两件事是一体的：给中位数是为了让人看到「平时多快」，
     * 给 P95 是为了让人看到「最坏有多坏」。
     *
     * 取位公式第一版写成 `floor((n-1)·p)`，这五个样本的 P95
     * 会算成 13 —— 那条 20 秒超时被完全抹掉，
     * 而它正是唯一值得看的东西。
     */
    reset();
    for (const l of [10, 12, 11, 13, 20_000]) row({ latencyMs: l });
    const [e] = mod.usageSummary(24, NOW).byEndpoint;
    assert.ok(e.medianMs <= 13, `中位数是 ${e.medianMs}，被那次超时带偏了`);
    assert.equal(e.p95Ms, 20_000, "P95 要能看见那次超时");
  });

  it("单个样本时两个数都等于它 —— 别在样本少的时候瞎算", () => {
    reset();
    row({ latencyMs: 77 });
    const [e] = mod.usageSummary(24, NOW).byEndpoint;
    assert.deepEqual({ m: e.medianMs, p: e.p95Ms }, { m: 77, p: 77 });
  });

  it("按调用方分得开", () => {
    reset();
    row({ triggeredBy: "sync" });
    row({ triggeredBy: "sync", statusCode: 500 });
    row({ triggeredBy: "web" });
    const s = mod.usageSummary(24, NOW);
    const sync = s.byCaller.find((c) => c.caller === "sync");
    assert.deepEqual({ calls: sync?.calls, errors: sync?.errors }, { calls: 2, errors: 1 });
  });

  it("窗口外的不算", () => {
    reset();
    row({ createdAt: NOW - 60_000 });
    row({ createdAt: NOW - 48 * 3_600_000 });
    assert.equal(mod.usageSummary(24, NOW).calls, 1);
  });

  it("**最近的失败按时间倒序** —— 先看最新那条", () => {
    reset();
    row({ statusCode: 500, createdAt: NOW - 300_000, error: "老的" });
    row({ statusCode: 500, createdAt: NOW - 1_000, error: "新的" });
    assert.equal(mod.usageSummary(24, NOW).recentFailures[0].error, "新的");
  });

  it("裁剪按保留天数删旧的", () => {
    reset();
    row({ createdAt: NOW - 10 * 86_400_000 });
    row({ createdAt: NOW - 100 * 86_400_000 });
    const gone = mod.pruneApiUsage(NOW);
    assert.equal(gone, 1);
    assert.equal(dbm.db.select().from(schema.apiUsage).all().length, 1);
  });

  it("空表不炸 —— 刚上线时就是这个状态", () => {
    reset();
    const s = mod.usageSummary(24, NOW);
    assert.deepEqual({ calls: s.calls, errors: s.errors, e: s.byEndpoint.length }, { calls: 0, errors: 0, e: 0 });
  });
});

describe("接线", () => {
  it("裁剪挂在存储裁剪那一步里 —— 不单开定时器", () => {
    /*
     * 分开两处的结果是有一处永远没人记得跑。
     * 它和分层裁剪回答的是同一个问题：库为什么这么大。
     */
    assert.match(strip(src("lib/storage/prune.ts")), /result\.usageRows = pruneApiUsage\(now\)/);
  });

  it("**裁剪不受 reversibleOnly 影响** —— 删运维流水没有什么可丢的", () => {
    /*
     * 判「有没有被塞进某个分支」要看**缩进**，不是看附近有没有出现过
     * `reversibleOnly` 那个词 —— 按距离判会因为上面几行提到过它而误报，
     * 第一版就是这么错的。
     *
     * 函数体顶层是两个空格；再深一层说明它在某个 if 里。
     */
    const line = strip(src("lib/storage/prune.ts"))
      .split("\n")
      .find((l) => l.includes("result.usageRows ="));
    assert.ok(line, "找不到这一行");
    assert.match(line, /^ {2}result\.usageRows/, `缩进是 ${line.length - line.trimStart().length} 空格，说明它在某个分支里`);
  });

  it("健康页真的把它显示出来了 —— 记了没人看跟没记一样", () => {
    const page = strip(src("app/(app)/admin/health/page.tsx"));
    assert.match(page, /usageSummary\(/);
    assert.match(page, /<UpstreamUsage/);
  });

  it("保留天数是可配的，不是魔法数字", () => {
    assert.match(strip(src("lib/upstream/usage.ts")), /getSettingInt\("upstream\.usage_retention_days"/);
  });
});
