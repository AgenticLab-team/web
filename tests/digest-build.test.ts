import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

/**
 * 每周精选的生成。
 *
 * 三条硬线：
 *
 * **① 只生成草稿，永远不发送。** 一个每周自动向一千六百人广播的
 * 机器人，被风控只是时间问题；而且没有人会为一条没人看过的
 * 自动消息负责。
 *
 * **② 限定范围的帖子不能混进去。** 精选是一条发进所有群的消息，
 * 一条「仅 A 群可见」的帖子会被念给 B 群听 ——
 * 而撤回窗口只有两分钟。
 *
 * **③ 不代任何用户发言。** 精选的署名是站点，不是任何一个人；
 * 匿名帖在精选里也保持匿名。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-digest-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";
process.env.SITE_URL = "https://agenticlab.sh";

type DbModule = typeof import("@/lib/db");

let dbm: DbModule;
let schema: typeof import("@/lib/db/schema");
let build: typeof import("@/lib/digest/build");
let store: typeof import("@/lib/settings/store");

/** 2026-08-03 是周一；这一周是 08-03 ~ 08-09 */
const WEEK = "2026-08-03";
/** 周三中午（东八区），落在这一周里 */
const IN_WEEK = Date.UTC(2026, 7, 5, 4);

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  build = await import("@/lib/digest/build");
  store = await import("@/lib/settings/store");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  for (const t of [schema.digestRuns, schema.broadcasts, schema.posts, schema.users]) {
    dbm.db.delete(t).run();
  }
  dbm.db
    .insert(schema.users)
    .values({ id: "author", wxId: "wx_author", wxNickname: "张三", status: "active" })
    .run();

  /*
   * 「启用每周精选回推」默认是关的 —— 这些用例测的是**开着的时候**
   * 选稿和落库对不对，所以先打开。
   *
   * 关着时的行为另有一组用例（见文件末尾）：那一条以前根本不存在，
   * 因为这个开关一直没有任何地方读它。
   */
  setEnabled(true);
});

/**
 * 周报现在是个正规模块，开关归 `module.digest.enabled`。
 *
 * 它还**依赖群发**（草稿要进群发队列等复核），而依赖被关掉时
 * `isModuleEnabled` 会算成关 —— 所以这里把依赖也一并打开，
 * 否则测的就不是「周报开关」而是「依赖链」。
 */
function setEnabled(on: boolean) {
  dbm.db.delete(schema.settings).run();
  dbm.db
    .insert(schema.settings)
    .values({
      key: "module.broadcast.enabled",
      value: "true",
      type: "bool",
      category: "broadcast",
    })
    .run();
  dbm.db
    .insert(schema.settings)
    .values({
      key: "module.digest.enabled",
      value: on ? "true" : "false",
      type: "bool",
      category: "digest",
    })
    .run();
  store.invalidateSettingsCache();
}

let seq = 0;
function post(over: Record<string, unknown> = {}) {
  const id = `p${++seq}`;
  dbm.db
    .insert(schema.posts)
    .values({
      id,
      boardId: "b1",
      authorId: "author",
      title: `帖子 ${id}`,
      content: "正文",
      contentHtml: "<p>正文</p>",
      excerpt: "摘要",
      type: "discussion",
      status: "published",
      visibility: "member",
      replyCount: 3,
      reactionCount: 2,
      createdAt: IN_WEEK,
      ...over,
    })
    .run();
  return id;
}

function broadcastRows() {
  return dbm.db.select().from(schema.broadcasts).all();
}
function runRows() {
  return dbm.db.select().from(schema.digestRuns).all();
}

describe("① 只生成草稿，永远不发送", () => {
  it("**生成出来的群发是 draft**", () => {
    post();
    post();
    const result = build.buildWeeklyDigest({ weekStart: WEEK });

    assert.equal(result.ok, true);
    const [row] = broadcastRows();
    assert.equal(row.status, "draft", "自动生成的东西直接进了待发或已发状态");
    assert.equal(row.channel, "wechat");
    assert.equal(row.approvedBy, null, "还没有人复核过");
  });

  it("**内容哈希提前算好** —— 复核之后再改内容，发送会被拒", async () => {
    post();
    post();
    build.buildWeeklyDigest({ weekStart: WEEK });

    const rules = await import("@/lib/broadcast/rules");
    const [row] = broadcastRows();
    assert.equal(row.contentHash, rules.contentHash(row.content));
  });

  it("**署名是系统，不是任何一个人** —— 站点不代用户发消息", () => {
    post();
    post();
    build.buildWeeklyDigest({ weekStart: WEEK });
    assert.equal(broadcastRows()[0].createdBy, build.SYSTEM_ACTOR);
  });

  it("目标群留空 = 所有已接入的群，内容只有一份", () => {
    post();
    post();
    build.buildWeeklyDigest({ weekStart: WEEK });
    assert.equal(broadcastRows().length, 1);
    assert.equal(broadcastRows()[0].targetConvIds, null);
  });
});

describe("② 限定范围的帖子不能混进去", () => {
  it("**仅某个群可见的帖子不进精选**", () => {
    post({ visibility: "member" });
    post({ visibility: "member" });
    const secret = post({ visibility: "group", title: "只有 A 群看得到的东西" });

    build.buildWeeklyDigest({ weekStart: WEEK });
    const content = broadcastRows()[0].content;

    assert.equal(content.includes("只有 A 群看得到的东西"), false, "群限定内容被发进了所有群");
    assert.equal(content.includes(secret), false);
  });

  it("仅某个身份组 / 私密的也不进", () => {
    post({ visibility: "member" });
    post({ visibility: "member" });
    post({ visibility: "role", title: "身份组限定" });
    post({ visibility: "private", title: "私密" });

    const content = build.buildWeeklyDigest({ weekStart: WEEK }) && broadcastRows()[0].content;
    assert.equal(content.includes("身份组限定"), false);
    assert.equal(content.includes("私密"), false);
  });

  it("已删除的帖子不进", () => {
    post();
    post();
    post({ title: "删掉的", deletedAt: IN_WEEK });
    assert.equal(broadcastRowsAfterBuild().includes("删掉的"), false);
  });

  it("草稿与隐藏的不进", () => {
    post();
    post();
    post({ title: "还是草稿", status: "draft" });
    post({ title: "被隐藏了", status: "hidden" });

    const content = broadcastRowsAfterBuild();
    assert.equal(content.includes("还是草稿"), false);
    assert.equal(content.includes("被隐藏了"), false);
  });

  function broadcastRowsAfterBuild(): string {
    build.buildWeeklyDigest({ weekStart: WEEK });
    return broadcastRows()[0]?.content ?? "";
  }
});

describe("③ 匿名帖保持匿名", () => {
  it("**精选不该成为反匿名的路**", () => {
    post({ anonymous: true, title: "匿名发的" });
    post();

    build.buildWeeklyDigest({ weekStart: WEEK });
    const content = broadcastRows()[0].content;

    assert.match(content, /匿名发的/);
    const anonLine = content.split("\n").find((l) => l.includes("匿名"))!;
    assert.equal(content.includes("张三 · ") && anonLine.includes("张三"), false, "匿名帖署了真名");
  });
});

describe("周范围", () => {
  it("只收这一周的帖子", () => {
    post({ title: "本周的" });
    post({ title: "也是本周的" });
    post({ title: "上上周的", createdAt: IN_WEEK - 14 * 86_400_000 });
    post({ title: "下周的", createdAt: IN_WEEK + 10 * 86_400_000 });

    build.buildWeeklyDigest({ weekStart: WEEK });
    const content = broadcastRows()[0].content;
    assert.equal(content.includes("上上周的"), false);
    assert.equal(content.includes("下周的"), false);
    assert.match(content, /本周的/);
  });

  it("**周界按东八区** —— 周一凌晨发的帖属于这一周", () => {
    // 东八区 2026-08-03 00:30 = UTC 2026-08-02 16:30
    post({ title: "周一凌晨", createdAt: Date.UTC(2026, 7, 2, 16, 30) });
    post({ title: "周三", createdAt: IN_WEEK });

    build.buildWeeklyDigest({ weekStart: WEEK });
    assert.match(broadcastRows()[0].content, /周一凌晨/);
  });

  it("默认取上一周", () => {
    // 2026-08-12 是周三，上一周的周一是 08-03
    assert.equal(build.previousWeekStart(Date.UTC(2026, 7, 12, 4)), "2026-08-03");
  });
});

describe("同一周不重复生成", () => {
  it("**第二次调用不再产生新草稿** —— 五条一样的草稿会让复核的人全部忽略", () => {
    post();
    post();

    const first = build.buildWeeklyDigest({ weekStart: WEEK });
    const second = build.buildWeeklyDigest({ weekStart: WEEK });

    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.match(second.reason, /已经生成过/);
    assert.equal(broadcastRows().length, 1);
  });

  it("**--force 重算这一周时，不该被它自己上次选的挡住**", () => {
    /*
     * 唯一会用到 force 的场景就是「这一周重新生成一遍」。
     * 「往期推过的不再推」如果把这一周自己也算进往期，
     * 候选会被清空，force 永远得到一个空精选 —— 一个看起来能用的死按钮。
     */
    post();
    post();
    build.buildWeeklyDigest({ weekStart: WEEK });
    const forced = build.buildWeeklyDigest({ weekStart: WEEK, force: true });

    assert.equal(forced.ok, true, forced.reason);
    assert.equal(forced.itemCount, 2);
    assert.equal(runRows().length, 1, "记录应该是覆盖不是新增");
  });

  it("**往期推过的帖子不再推第二次**", () => {
    const a = post({ title: "第一周就推过的" });
    post();
    build.buildWeeklyDigest({ weekStart: WEEK });
    assert.match(broadcastRows()[0].content, /第一周就推过的/);

    // 下一周：那篇仍然满足条件，但不该再出现
    dbm.db.update(schema.posts).set({ createdAt: IN_WEEK + 7 * 86_400_000 }).where(eq(schema.posts.id, a)).run();
    post({ title: "新的一", createdAt: IN_WEEK + 7 * 86_400_000 });
    post({ title: "新的二", createdAt: IN_WEEK + 7 * 86_400_000 });

    build.buildWeeklyDigest({ weekStart: "2026-08-10" });
    const second = broadcastRows().find((b) => b.title?.includes("10 日"))!;
    assert.equal(second.content.includes("第一周就推过的"), false, "同一篇被推了两周");
    assert.match(second.content, /新的一/);
  });
});

describe("没内容就不发，但要留痕", () => {
  it("**一条都没有时不生成草稿**", () => {
    const result = build.buildWeeklyDigest({ weekStart: WEEK });
    assert.equal(result.ok, false);
    assert.equal(broadcastRows().length, 0);
    assert.match(result.reason, /不发比发一条空的好/);
  });

  it("只有一条时也不生成 —— 比没有精选更显得冷清", () => {
    post();
    const result = build.buildWeeklyDigest({ weekStart: WEEK });
    assert.equal(result.ok, false);
    assert.equal(broadcastRows().length, 0);
  });

  it("**判定为不发也要留一行** —— 「这周怎么没有精选」要答得上来", () => {
    build.buildWeeklyDigest({ weekStart: WEEK });
    const [row] = runRows();
    assert.ok(row, "什么记录都没留，事后查不出这周跑没跑过");
    assert.equal(row.broadcastId, null);
    assert.ok(row.skipReason);
  });

  it("说得出哪些候选被挡下了、为什么", () => {
    post({ visibility: "group" });
    post({ replyCount: 0, reactionCount: 0 });

    const result = build.buildWeeklyDigest({ weekStart: WEEK });
    assert.equal(result.rejected.length, 2);
    assert.ok(result.rejected.some((r) => /不能发进所有群/.test(r.reason)));
    assert.ok(result.rejected.some((r) => /够不上/.test(r.reason)));
  });
});

describe("内容形态", () => {
  it("标题里有周次，正文里每条都带可点的链接", () => {
    const a = post();
    post();
    build.buildWeeklyDigest({ weekStart: WEEK });
    const row = broadcastRows()[0];

    assert.match(row.title ?? "", /8 月 3 日那周/);
    assert.match(row.content, new RegExp(`https://agenticlab\\.sh/forum/p/${a}`));
    assert.match(row.content, /https:\/\/agenticlab\.sh\/forum$/);
  });

  it("长度不超过群发的上限", async () => {
    const rules = await import("@/lib/broadcast/rules");
    for (let i = 0; i < 5; i++) post({ title: "很长的标题".repeat(20), excerpt: "很长的摘要".repeat(20) });

    build.buildWeeklyDigest({ weekStart: WEEK });
    assert.ok(broadcastRows()[0].content.length <= rules.MAX_WECHAT_LENGTH);
  });
});

/* ───────────────────────────────────────────────────────────────
 * 那个一直没人读的开关
 * ─────────────────────────────────────────────────────────────── */

describe("**每周精选这个模块的开关**", () => {
  /*
   * 它在后台摆了很久 —— 关掉，定时任务照样每周生成草稿。
   * 一个拨了没反应的旋钮比没有旋钮坏：管理员拨完不会再去验证。
   */
  it("关掉之后不生成", () => {
    setEnabled(false);
    post();
    post();
    const result = build.buildWeeklyDigest({ weekStart: WEEK });
    assert.equal(result.ok, false);
    assert.equal(result.itemCount, 0);
  });

  it("**理由要说清是「被关掉了」，不是「这周没内容」**", () => {
    // 两者的下一步完全不同：一个去后台打开，一个等下周
    setEnabled(false);
    post();
    post();
    const { reason } = build.buildWeeklyDigest({ weekStart: WEEK });
    assert.match(reason, /没有启用/);
  });

  it("关掉时**不往 digest_runs 里写「这周不发」** —— 那是内容判定，不是开关", () => {
    /*
     * 写进去的话，之后把开关打开、再跑这一周，会撞上
     * 「这一周已经判定为不发」而直接跳过 —— 而它根本没判定过。
     */
    setEnabled(false);
    post();
    post();
    build.buildWeeklyDigest({ weekStart: WEEK });
    assert.equal(dbm.db.select().from(schema.digestRuns).all().length, 0);
  });

  it("打开之后照常生成", () => {
    setEnabled(false);
    post();
    post();
    build.buildWeeklyDigest({ weekStart: WEEK });
    setEnabled(true);
    const result = build.buildWeeklyDigest({ weekStart: WEEK });
    assert.equal(result.ok, true, result.reason);
  });
});
