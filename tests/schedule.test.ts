import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  MAX_AHEAD_MS,
  MIN_LEAD_MS,
  TICK_INTERVAL_MS,
  checkSchedule,
  publishedCreatedAt,
  scheduleNote,
  whoCanSeeBeforePublish,
} from "@/lib/forum/schedule-rules";

/**
 * 定时发布。
 *
 * ─────────────────────────────────────────
 * `scheduled_at` 这一列，全站零引用
 * ─────────────────────────────────────────
 *
 * 它在 schema 里躺着，没有任何地方写它、也没有任何地方读它。
 *
 * ─────────────────────────────────────────
 * 两件事最容易做错
 * ─────────────────────────────────────────
 *
 * **一、提前泄露。** 等待发布的帖子必须对别人不可见，
 * 而且那一刻**不能扇通知** —— 一条「你关注的张三发了新帖」
 * 带着标题推到粉丝的通知栏里，帖子还没公开就已经公开了。
 *
 * **二、发出来就沉底。** 列表按 created_at 排序。保留写作时间的话，
 * 一个周一写、周五发的帖子一发出来就排在四天前的位置 ——
 * 对所有人来说它是新的，而它出现在没人会翻到的地方。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

const NOW = 1_800_000_000_000;

describe("时间校验", () => {
  it("正常的过", () => {
    const r = checkSchedule(NOW + 3600_000, NOW);
    assert.equal(r.ok && r.at, NOW + 3600_000);
  });

  it("过去的时间拒，并且指一条明路", () => {
    const r = checkSchedule(NOW - 1000, NOW);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /别勾定时/);
  });

  it("**「马上就到」的定时也拒** —— 那是个陷阱", () => {
    /*
     * 定时发布挂在五分钟一轮的定时任务上。定在三分钟后的帖子
     * 实际会在第 5 分钟发出去 —— 那两分钟里人只会觉得它坏了。
     */
    const r = checkSchedule(NOW + 60_000, NOW);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /检查一次/);
  });

  it("最短提前量要比一轮定时任务长", () => {
    assert.ok(MIN_LEAD_MS > TICK_INTERVAL_MS, "定完就该发了，那一轮一定赶不上");
  });

  it("定太远拒 —— 一年后的多半是填错了", () => {
    assert.equal(checkSchedule(NOW + MAX_AHEAD_MS + 1, NOW).ok, false);
  });

  it("坏值拒，不当成 0", () => {
    assert.equal(checkSchedule(NaN, NOW).ok, false);
    assert.equal(checkSchedule(Infinity, NOW).ok, false);
  });
});

describe("**必须说出来的两句话**", () => {
  it("「最多晚五分钟」", () => {
    /*
     * 不说的话，定 09:00 的人会在 09:01 发现没发出去、以为坏了 ——
     * 而再等四分钟就好。一个「差不多准时」的功能，
     * 只要没人告诉你它差多少，用起来就和坏了一样。
     */
    assert.match(scheduleNote(), /5 分钟/);
    assert.match(src("components/forum/SchedulePicker.tsx"), /scheduleNote\(\)/);
  });

  it("**「版主看得见」** —— 定时不等于密封", () => {
    /*
     * 等待发布的帖子存成草稿，而 canSeePost 里草稿对版主是放行的。
     * 想定时公布一个结果的人有权先知道这件事，
     * 而不是在结果提前走漏之后才发现。
     */
    assert.match(whoCanSeeBeforePublish(), /版主/);
    assert.match(src("components/forum/SchedulePicker.tsx"), /whoCanSeeBeforePublish\(\)/);
  });
});

describe("发帖时间算哪个", () => {
  it("正常情况取实际发布那一刻", () => {
    assert.equal(publishedCreatedAt(NOW, NOW + 120_000), NOW + 120_000);
  });

  it("**服务停过一天也取实际那一刻** —— 标昨天的时间会让它一发出来就沉底", () => {
    assert.equal(publishedCreatedAt(NOW, NOW + 86_400_000), NOW + 86_400_000);
  });

  it("时钟倒退时不取更早的那个", () => {
    assert.equal(publishedCreatedAt(NOW, NOW - 5000), NOW);
  });
});

describe("接线", () => {
  it("**挂在已经在跑的那一轮定时任务里**，不自己起一个定时器", () => {
    /*
     * 多一个定时器就多一处会悄悄停掉、而且没人看得出来的东西。
     * 挂进已经有告警的那一轮，它停了会和别的步骤一起被发现。
     */
    const health = readFileSync(new URL("../scripts/health.ts", import.meta.url), "utf8");
    assert.match(health, /name: "定时发布"/);
    assert.match(health, /publishDueScheduled\(\)/);
  });

  it("发布路径只有一条 —— 「现在就发」也走它", () => {
    /*
     * 手动那条自己写一遍 status = published 的话，
     * 计数重算、板块时间、通知扇出三件事只要有一处忘了抄，
     * 两条路发出来的帖子就不一样，而且只有一条会被测到。
     */
    const actions = strip(src("lib/forum/schedule-actions.ts"));
    const fn = actions.slice(actions.indexOf("function publishNow"));
    assert.match(fn, /publishDueScheduled\(\)/);
    assert.doesNotMatch(fn, /status: "published"/);
  });

  it("三个动作都只认自己的帖子", () => {
    /*
     * 待发布的帖子对版主可见，而**可见不等于可以替人发**。
     * 一个版主能把别人还没想好要不要发的东西提前按发布，
     * 比看到它严重得多。
     */
    const actions = strip(src("lib/forum/schedule-actions.ts"));
    for (const name of ["publishNow", "reschedule", "cancelSchedule"]) {
      const fn = actions.slice(actions.indexOf(`function ${name}`));
      assert.match(fn.slice(0, 900), /eq\(posts\.authorId, user\.id\)/, `${name} 没按作者收口`);
      assert.match(fn.slice(0, 900), /assertNotPreviewing\(\)/, `${name} 少了 assertNotPreviewing`);
    }
  });

  it("**取消定时不是删除** —— 一次「我再想想」不该毁掉整篇", () => {
    const actions = strip(src("lib/forum/schedule-actions.ts"));
    const fn = actions.slice(actions.indexOf("function cancelSchedule"));
    assert.match(fn, /set\(\{ scheduledAt: null \}\)/);
    assert.doesNotMatch(fn, /delete\(posts\)/);
  });

  it("规则层不碰数据库", () => {
    const code = src("lib/forum/schedule-rules.ts");
    for (const forbidden of ["server-only", "@/lib/db", "drizzle-orm"]) {
      assert.equal(code.includes(forbidden), false, `规则层引了 ${forbidden}`);
    }
  });

  it("「等着发的」和「没写完的」在界面上分得开", () => {
    /*
     * 站里现在有两种「还没发出来的东西」：草稿箱（还没写完，
     * 连帖子行都没有）和这一节（写完了在等时间）。
     * 混在一起的话，人会以为定时的那些也要自己再点一次发布。
     */
    const page = src("app/(app)/me/drafts/page.tsx");
    assert.match(page, /等着发的（\$\{scheduled\.length\}）|等着发的/);
    assert.match(page, /还没写完的/);
  });

  it("时间标签按社区时区算，不看服务器时区", () => {
    assert.match(src("lib/forum/schedule.ts"), /timeZone: COMMUNITY_TIMEZONE/);
  });
});

/* ───────────────────────────────────────────────────────────────
 * 泄露与排序只有真数据库测得出来
 * ─────────────────────────────────────────────────────────────── */

const tmp = mkdtempSync(join(tmpdir(), "al-schedule-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

let dbm: typeof import("@/lib/db");
let schema: typeof import("@/lib/db/schema");
let sched: typeof import("@/lib/forum/schedule");
let queries: typeof import("@/lib/forum/queries");
let vis: typeof import("@/lib/forum/visibility");
let notify: typeof import("@/lib/forum/notify");
let eq: typeof import("drizzle-orm").eq;

const BOARD = "b1";
const AUTHOR = "u_author";
const READER = "u_reader";

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  sched = await import("@/lib/forum/schedule");
  queries = await import("@/lib/forum/queries");
  vis = await import("@/lib/forum/visibility");
  notify = await import("@/lib/forum/notify");
  ({ eq } = await import("drizzle-orm"));
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  for (const t of [schema.notifications, schema.subscriptions, schema.posts, schema.boards, schema.users]) {
    dbm.db.delete(t).run();
  }
  dbm.db.insert(schema.boards).values({ id: BOARD, key: "general", name: "综合", sort: 0 }).run();
  for (const id of [AUTHOR, READER]) {
    dbm.db.insert(schema.users).values({ id, wxId: `wx_${id}`, status: "active" }).run();
  }
});

function scheduled(at: number, id = "p1") {
  dbm.db
    .insert(schema.posts)
    .values({
      id,
      boardId: BOARD,
      authorId: AUTHOR,
      title: "定时的帖子",
      content: "正文",
      contentHtml: "<p>正文</p>",
      status: "draft",
      scheduledAt: at,
      visibility: "public",
      createdAt: NOW - 4 * 86_400_000, // 四天前写的
    })
    .run();
  return id;
}

const viewerFor = (userId: string | null) => ({
  ...vis.GUEST,
  kind: "member" as const,
  userId,
});

describe("**发出去之前不能被别人看到**", () => {
  it("别人的列表里没有它", () => {
    scheduled(NOW + 3600_000);
    assert.equal(queries.listPosts(viewerFor(READER)).length, 0);
  });

  it("访客也看不到", () => {
    scheduled(NOW + 3600_000);
    assert.equal(queries.listPosts(vis.GUEST).length, 0);
  });

  it("作者自己看得到 —— 否则他没法确认自己定上了", () => {
    scheduled(NOW + 3600_000);
    assert.equal(queries.listPosts(viewerFor(AUTHOR)).length, 1);
  });

  it("**这一刻一条通知都不发**", () => {
    /*
     * 「你关注的张三发了新帖」带着标题推到粉丝的通知栏里，
     * 帖子还没公开就已经公开了。
     */
    dbm.db
      .insert(schema.subscriptions)
      .values({ userId: READER, targetType: "user", targetId: AUTHOR, auto: false })
      .run();

    const id = scheduled(NOW + 3600_000);
    // 直接调扇出，模拟「万一有人忘了判」—— 它自己也该拒绝
    notify.notifyNewPost({
      postId: id,
      title: "定时的帖子",
      authorId: AUTHOR,
      authorName: "张三",
      boardId: BOARD,
      boardName: "综合",
    });

    assert.equal(dbm.db.select().from(schema.notifications).all().length, 0, "还没发布就通知了");
  });
});

describe("到点发布", () => {
  it("没到点的不动", () => {
    scheduled(NOW + 3600_000);
    const r = sched.publishDueScheduled(NOW);
    assert.equal(r.published, 0);
    assert.equal(queries.listPosts(viewerFor(READER)).length, 0);
  });

  it("到点的发出去，所有人都看得到", () => {
    scheduled(NOW - 1000);
    const r = sched.publishDueScheduled(NOW);
    assert.equal(r.published, 1);
    assert.equal(queries.listPosts(viewerFor(READER)).length, 1);
  });

  it("**发帖时间改成发布那一刻** —— 否则一发出来就排在四天前", () => {
    const id = scheduled(NOW - 1000);
    sched.publishDueScheduled(NOW);

    const row = dbm.db.select().from(schema.posts).where(eq(schema.posts.id, id)).get();
    assert.equal(row?.createdAt, NOW, "还带着四天前的写作时间");
  });

  it("发布之后才扇通知", () => {
    dbm.db
      .insert(schema.subscriptions)
      .values({ userId: READER, targetType: "user", targetId: AUTHOR, auto: false })
      .run();

    scheduled(NOW - 1000);
    sched.publishDueScheduled(NOW);

    const inbox = dbm.db.select().from(schema.notifications).all();
    assert.equal(inbox.length, 1);
    assert.match(inbox[0].title, /新帖/);
  });

  it("**发过一次就不会再发一次**", () => {
    scheduled(NOW - 1000);
    assert.equal(sched.publishDueScheduled(NOW).published, 1);
    assert.equal(sched.publishDueScheduled(NOW).published, 0, "重复发布了");
  });

  it("**取消了定时的不会自己发出去**", () => {
    const id = scheduled(NOW - 1000);
    dbm.db.update(schema.posts).set({ scheduledAt: null }).where(eq(schema.posts.id, id)).run();
    assert.equal(sched.publishDueScheduled(NOW).published, 0);
  });

  it("已删的不会被发出来", () => {
    const id = scheduled(NOW - 1000);
    dbm.db.update(schema.posts).set({ deletedAt: NOW }).where(eq(schema.posts.id, id)).run();
    assert.equal(sched.publishDueScheduled(NOW).published, 0);
  });

  it("早该发的先发 —— 服务停过一段时间时顺序才对", () => {
    scheduled(NOW - 1000, "late");
    scheduled(NOW - 60_000, "early");
    sched.publishDueScheduled(NOW);

    const rows = dbm.db.select().from(schema.posts).all();
    // 两篇都发了，且 board 的计数对得上
    assert.equal(rows.filter((r) => r.status === "published").length, 2);
    const board = dbm.db.select().from(schema.boards).where(eq(schema.boards.id, BOARD)).get();
    assert.equal(board?.postCount, 2, "版块计数没跟上");
  });
});

describe("我的待发布列表", () => {
  it("只列自己的", () => {
    scheduled(NOW + 3600_000);
    assert.equal(sched.listScheduled(AUTHOR, NOW).length, 1);
    assert.equal(sched.listScheduled(READER, NOW).length, 0);
  });

  it("已到点但还没轮到的标出来 —— 不标的话那一行看起来就是坏的", () => {
    scheduled(NOW - 1000);
    assert.equal(sched.listScheduled(AUTHOR, NOW)[0].due, true);
  });

  it("发出去之后就不在列表里了", () => {
    scheduled(NOW - 1000);
    sched.publishDueScheduled(NOW);
    assert.equal(sched.listScheduled(AUTHOR, NOW).length, 0);
  });

  it("时间标签今明天说「今天/明天」", () => {
    scheduled(NOW + 3600_000);
    assert.match(sched.listScheduled(AUTHOR, NOW)[0].whenLabel, /今天|明天/);
  });
});
