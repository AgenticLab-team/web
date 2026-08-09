import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * 同一条通知不该因为刷新页面就再弹一遍。
 *
 * ─────────────────────────────────────────
 * 之前是怎么弹三遍的
 * ─────────────────────────────────────────
 *
 * 补漏有两条路：SSE 断线用 Last-Event-ID 续，整页被杀用 localStorage
 * 游标续。两条都落到 `listSince(user, 游标)`，而它是**含端点**的（>=）——
 * 游标恰恰就是最后一条的 updatedAt，所以边界那一条每次冷启动都会被原样带回来。
 *
 * 这个重发本来说好由客户端「按 id 幂等消化」。但那份幂等记忆是 effect
 * 闭包里的一个 Set，**整页重新加载就没了**。于是：吐司弹出 → 点进帖子 →
 * 刷新 → 又弹一遍 → 再刷新 → 再弹一遍，点几次刷几次都不会停。
 *
 * ─────────────────────────────────────────
 * 为什么修法是「只认 readAt」
 * ─────────────────────────────────────────
 *
 * 把 >= 改成 > 会丢掉同一毫秒里的第二条 —— 漏一条 @ 比重复弹一次糟得多。
 * 真正的毛病是「读到哪了」存了两份：服务端的 notifications.readAt，
 * 和浏览器 localStorage 里的游标。两份状态必然分叉，分叉的表现就是重复弹窗。
 *
 * 所以真值只留一份：游标只回答「从哪个时刻开始补」，
 * 「哪几条已经知道了」一律问 readAt。这一份跨刷新、跨设备、跨补漏路径都成立。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-ntf-replay-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";
delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;
delete process.env.VAPID_SUBJECT;

let dbm: typeof import("@/lib/db");
let schema: typeof import("@/lib/db/schema");
let live: typeof import("@/lib/notifications/live");
let notify: typeof import("@/lib/forum/notify");

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  live = await import("@/lib/notifications/live");
  notify = await import("@/lib/forum/notify");
});

after(() => {
  live.stopWatcher();
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  dbm.db.delete(schema.notifications).run();
});

function insert(input: {
  userId: string;
  title: string;
  updatedAt: number;
  readAt?: number | null;
}) {
  const id = `ntf-${input.userId}-${input.updatedAt}`;
  dbm.db
    .insert(schema.notifications)
    .values({
      id,
      userId: input.userId,
      type: "reply_to_post",
      groupKey: id,
      title: input.title,
      count: 1,
      readAt: input.readAt ?? null,
      createdAt: input.updatedAt,
      updatedAt: input.updatedAt,
    })
    .run();
  return id;
}

describe("**弹过并且点掉的通知，刷新多少次都不该再弹**", () => {
  it("站长那条路径：吐司 → 帖子 → 刷新 → 再刷新，只弹第一次", () => {
    /*
     * 逐帧复现。客户端游标写的是「收到的最后一条的 updatedAt」，
     * 所以下一次冷启动的补漏窗口起点就等于这条通知自己的时间。
     */
    const at = 1_700_000_000_000;
    const id = insert({ userId: "u1", title: "张三回复了你的帖子", updatedAt: at });
    const cursor = at; // 客户端 writeCursor(data.updatedAt) 之后 localStorage 里的值

    assert.equal(
      live.listSince("u1", cursor).length,
      1,
      "还没点的时候本来就该补回来 —— 含端点的重发是有意的",
    );

    // 点吐司 = 点进那条回复，服务端写下 readAt
    notify.markRead("u1", id);

    assert.deepEqual(live.listSince("u1", cursor), [], "第一次刷新就不该再回放");
    assert.deepEqual(live.listSince("u1", cursor), [], "第二次刷新同样");
    assert.deepEqual(live.listSince("u1", cursor), [], "第三次刷新同样 —— 站长点了三次");
  });

  it("在哪儿点掉的都算数 —— 通知中心点掉的，另一台设备重连也不该补回来", () => {
    /*
     * 「已读」如果由各端自己在本地记账，手机上点掉的那条到了电脑上
     * 仍然是新的。真值只能有一份，所以这里问的是同一个 readAt。
     */
    const id = insert({ userId: "u1", title: "有人回复了你", updatedAt: 5_000 });
    notify.markRead("u1", id); // 通知中心那一行走的也是这个

    assert.deepEqual(live.listSince("u1", 0), [], "另一台设备的游标从 0 开始也不该补到它");
  });

  it("**没读过的照补** —— 别为了不重复就把真没看过的吞掉", () => {
    /*
     * 这条挡的是「一刀切：回放全关掉」那种修法。
     * 漏掉一条 @，当事人会以为自己没被 @ —— 比重复弹一次糟得多。
     */
    insert({ userId: "u1", title: "看过了", updatedAt: 1_000, readAt: 1_500 });
    insert({ userId: "u1", title: "没看过", updatedAt: 2_000 });

    assert.deepEqual(
      live.listSince("u1", 0).map((n) => n.title),
      ["没看过"],
    );
  });

  it("回放名额先给未读 —— 已读的旧闻不能把 limit 吃光", () => {
    /*
     * 这条锁的是「过滤写在 SQL 里，不是取回来再 filter」。
     * 取 100 条回来再筛的话，一屋子已读旧闻会先把名额占满，
     * 真正要补的那几条未读被截在窗口外 —— 断线期间被 @ 了却什么都没补上。
     */
    for (let i = 0; i < 5; i++) {
      insert({ userId: "u1", title: `旧的已读 ${i}`, updatedAt: 1_000 + i, readAt: 9_999 });
    }
    insert({ userId: "u1", title: "未读甲", updatedAt: 2_000 });
    insert({ userId: "u1", title: "未读乙", updatedAt: 2_001 });

    assert.deepEqual(
      live.listSince("u1", 0, 2).map((n) => n.title),
      ["未读甲", "未读乙"],
    );
  });

  it("补回来的未读数仍是服务端算的绝对值 —— 角标靠它幂等", () => {
    insert({ userId: "u1", title: "未读1", updatedAt: 1_000 });
    insert({ userId: "u1", title: "已读", updatedAt: 2_000, readAt: 2_500 });
    insert({ userId: "u1", title: "未读2", updatedAt: 3_000 });

    const got = live.listSince("u1", 0);
    assert.equal(got.length, 2);
    for (const item of got) assert.equal(item.unread, 2);
  });
});

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

describe("**点吐司就是「我看到了」**", () => {
  /*
   * 上面那条规则要成立，得先有人把 readAt 写下去。
   * 而底部那张卡片曾经是个光秃秃的 <Link>：点进去看完，库里仍然是未读 ——
   * 于是「已读」这个真值在这条路径上根本没有被写过，规则再对也用不上。
   */
  const toastSrc = strip(src("components/notifications/LiveNotifications.tsx"));

  it("吐司带着通知 id，点击时走和通知中心同一个 action", () => {
    assert.match(toastSrc, /markNotificationsRead\(id\)/, "点了不标已读，刷新还会再弹");
    assert.match(toastSrc, /onClick=\{\(\) => dismiss\(toast\)\}/);
    assert.match(toastSrc, /id: data\.id/, "吐司得记住自己是哪一条");
  });

  it("**折叠成「离线期间有 N 条」的不替用户标已读** —— 那 N 条一条都没露过面", () => {
    assert.match(toastSrc, /id: n === 1 \? data\.id : null/);
    assert.match(toastSrc, /if \(!id\) return;/);
  });

  it("标完把新的未读数写进角标小仓库 —— 角标不在这棵树里，revalidate 碰不到", () => {
    assert.match(toastSrc, /if \(result\.ok\) setLiveUnread\(result\.unread\)/);
  });

  it("先收起吐司再等服务端 —— 点完就跳走，回来那次更新已经没人接了", () => {
    const fn = toastSrc.slice(toastSrc.indexOf("const dismiss ="));
    assert.ok(
      fn.indexOf("setToasts(") < fn.indexOf("await markNotificationsRead"),
      "等服务端回来才收吐司",
    );
  });
});

describe("**「读到哪了」只准有一份**", () => {
  it("localStorage 里只有补漏游标，没有第二份已读账本", () => {
    /*
     * 一旦本地也记一份「这几条我弹过了」，它和服务端的 readAt 就会分叉：
     * 换设备、清缓存、隐私模式，各自都是另一套答案。
     */
    const client = strip(src("components/notifications/LiveNotifications.tsx"));
    const keys = [...client.matchAll(/localStorage\.(?:get|set|remove)Item\((\w+)/g)].map(
      (m) => m[1],
    );
    assert.deepEqual([...new Set(keys)], ["CURSOR_KEY"], "客户端存了游标之外的通知状态");
  });

  it("补漏查询把已读挡在 SQL 里 —— 取回来再 filter 会让 limit 被已读吃光", () => {
    const server = strip(src("lib/notifications/live.ts"));
    const fn = server.slice(server.indexOf("export function listSince"));
    assert.match(fn.slice(0, fn.indexOf("orderBy")), /isNull\(notifications\.readAt\)/);
  });
});
