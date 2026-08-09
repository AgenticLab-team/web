import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

/**
 * 「帖子置顶一天」这件商品的完整链路。
 *
 * ─────────────────────────────────────────
 * 之前这一单是收了钱什么都不做
 * ─────────────────────────────────────────
 *
 * `deliver()` 里没有 highlight 这个分支，落到最后一行的
 * `{ kind, note: "无需自动交付" }`。而 highlight 属于「即时交付」，
 * 于是订单直接标成 fulfilled、提示「已到账」—— 五百分扣了，
 * 帖子一动没动，页面上一切正常。
 *
 * 另一半是 `pinned_until` 这一列**从来没有人读**：
 * 排序只看 pinned 布尔，所以一次「置顶一天」等于置顶到天荒地老。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-pin-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

type DbModule = typeof import("@/lib/db");

let dbm: DbModule;
let schema: typeof import("@/lib/db/schema");
let purchase: typeof import("@/lib/shop/purchase");
let pinSettle: typeof import("@/lib/forum/pin-settle");
let forum: typeof import("@/lib/forum/queries");

const HOUR = 3600_000;

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  purchase = await import("@/lib/shop/purchase");
  pinSettle = await import("@/lib/forum/pin-settle");
  forum = await import("@/lib/forum/queries");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

let seq = 0;

beforeEach(() => {
  for (const t of [
    schema.orders,
    schema.shopItems,
    schema.pointsLedger,
    schema.notifications,
    schema.posts,
    schema.boards,
    schema.users,
  ]) {
    dbm.db.delete(t).run();
  }

  dbm.db
    .insert(schema.users)
    .values({ id: "me", wxId: "wx_me", wxNickname: "我", status: "active", points: 5000 })
    .run();
  dbm.db
    .insert(schema.boards)
    .values({ id: "b1", key: "b1", name: "闲聊", sort: 0 })
    .run();
  dbm.db
    .insert(schema.shopItems)
    .values({
      id: "item_pin",
      key: "highlight_post",
      kind: "highlight",
      name: "帖子置顶一天",
      price: 500,
      enabled: true,
      config: { hours: 24 },
    })
    .run();
});

function post(over: Record<string, unknown> = {}) {
  const id = `p${++seq}`;
  dbm.db
    .insert(schema.posts)
    .values({
      id,
      boardId: "b1",
      authorId: "me",
      title: `帖子 ${id}`,
      content: "正文",
      contentHtml: "<p>正文</p>",
      type: "discussion",
      status: "published",
      visibility: "member",
      ...over,
    })
    .run();
  return id;
}

function buy(targetRef?: string, userId = "me") {
  return purchase.purchaseItem({
    userId,
    itemKey: "highlight_post",
    balance: 5000,
    targetRef,
    idempotencyKey: `k${++seq}`,
  });
}

function postRow(id: string) {
  return dbm.db.select().from(schema.posts).where(eq(schema.posts.id, id)).get()!;
}
function points(userId = "me") {
  return dbm.db.select().from(schema.users).where(eq(schema.users.id, userId)).get()!.points;
}

describe("**买了置顶，帖子真的被置顶了**", () => {
  it("扣分、下单、置顶三件事都发生", () => {
    const id = post();
    const result = buy(id);

    assert.equal(result.ok, true, result.error);
    assert.equal(points(), 4500);

    const row = postRow(id);
    assert.equal(row.pinned, true, "钱扣了，帖子却没被置顶");
    assert.ok(row.pinnedUntil, "没有设到期时间 —— 那就是永久置顶了");
    assert.ok(row.pinnedUntil! > Date.now() + 23 * HOUR);
  });

  it("订单里记下了交付结果，能对账", () => {
    const id = post();
    buy(id);
    const order = dbm.db.select().from(schema.orders).all()[0];
    assert.equal(order.status, "fulfilled");
    assert.equal((order.fulfillResult as { pinnedPost?: string })?.pinnedPost, id);
  });
});

describe("扣分之前就要拦下来", () => {
  it("**没选帖子不能买** —— 而不是买完了才发现没目标", () => {
    const result = buy(undefined);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /先选一个/);
    assert.equal(points(), 5000, "被拒了却扣了分");
  });

  it("帖子不存在时不扣分", () => {
    const result = buy("nope");
    assert.equal(result.ok, false);
    assert.equal(points(), 5000);
  });

  it("**别人的帖子不能买** —— 否则就是花钱把别人的帖子顶上去", () => {
    dbm.db
      .insert(schema.users)
      .values({ id: "other", wxId: "wx_other", status: "active", points: 5000 })
      .run();
    const id = post({ authorId: "other" });

    const result = buy(id);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /自己的帖子/);
    assert.equal(points(), 5000);
    assert.equal(postRow(id).pinned, false);
  });

  it("已删除的帖子不能买，且不扣分", () => {
    const id = post({ deletedAt: Date.now() });
    assert.equal(buy(id).ok, false);
    assert.equal(points(), 5000);
  });

  it("**版块的付费置顶位占着就不卖** —— 收了钱排队比不卖更伤人", () => {
    const first = post();
    assert.equal(buy(first).ok, true);

    const second = post();
    const result = buy(second);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /被占着/);
    assert.equal(points(), 4500, "第二单不该扣分");
    assert.equal(postRow(second).pinned, false);
  });

  it("前一个到期之后又能卖了", () => {
    const first = post();
    buy(first);
    // 手动把它拨到过期
    dbm.db
      .update(schema.posts)
      .set({ pinnedUntil: Date.now() - 1 })
      .where(eq(schema.posts.id, first))
      .run();

    const second = post();
    assert.equal(buy(second).ok, true);
  });

  it("管理员的永久置顶不占付费名额", () => {
    post({ pinned: true, pinnedUntil: null });
    const mine = post();
    assert.equal(buy(mine).ok, true, "管理员置顶把付费位也占了");
  });

  it("被拒之后库存与销量不受影响", () => {
    const before = dbm.db.select().from(schema.shopItems).all()[0].sold;
    buy(undefined);
    assert.equal(dbm.db.select().from(schema.shopItems).all()[0].sold, before);
  });
});

describe("**置顶会到期** —— 之前它是永久的", () => {
  it("排序只把还有效的排前面", () => {
    const pinned = post({ title: "买了置顶的" });
    buy(pinned);
    const newer = post({ title: "更新的普通帖" });

    const viewer = { userId: "me", kind: "member", groupIds: [], roleIds: [], canModerate: true };
    const before = forum.listPosts(viewer as never, { boardId: "b1", sort: "created" });
    assert.equal(before[0].id, pinned, "置顶的没排在前面");

    // 拨到过期
    dbm.db
      .update(schema.posts)
      .set({ pinnedUntil: Date.now() - 1 })
      .where(eq(schema.posts.id, pinned))
      .run();

    const after = forum.listPosts(viewer as never, { boardId: "b1", sort: "created" });
    assert.equal(after[0].id, newer, "过期的置顶还霸着第一位");
  });

  it("列表上的置顶标记也跟着过期", () => {
    const id = post();
    buy(id);
    dbm.db
      .update(schema.posts)
      .set({ pinnedUntil: Date.now() - 1 })
      .where(eq(schema.posts.id, id))
      .run();

    const viewer = { userId: "me", kind: "member", groupIds: [], roleIds: [], canModerate: true };
    const item = forum.listPosts(viewer as never, { boardId: "b1" }).find((p) => p.id === id)!;
    assert.equal(item.pinned, false, "过期了还带着置顶标");
  });
});

describe("到期清理", () => {
  it("**把过期的标记清掉** —— 一个和事实不符的标记迟早有人照它做决定", () => {
    const id = post();
    buy(id);
    dbm.db
      .update(schema.posts)
      .set({ pinnedUntil: Date.now() - 1 })
      .where(eq(schema.posts.id, id))
      .run();

    const result = pinSettle.settleExpiredPins();
    assert.equal(result.cleared, 1);
    assert.equal(postRow(id).pinned, false);
    assert.equal(postRow(id).pinnedUntil, null);
  });

  it("**告诉买的人它结束了** —— 悄无声息地消失会让人怀疑上次到底有没有生效", () => {
    const id = post();
    buy(id);
    dbm.db
      .update(schema.posts)
      .set({ pinnedUntil: Date.now() - 1 })
      .where(eq(schema.posts.id, id))
      .run();

    pinSettle.settleExpiredPins();
    const list = dbm.db.select().from(schema.notifications).all();
    assert.equal(list.length, 1);
    assert.match(list[0].title, /置顶已结束/);
  });

  it("还没到期的不动", () => {
    const id = post();
    buy(id);
    assert.equal(pinSettle.settleExpiredPins().cleared, 0);
    assert.equal(postRow(id).pinned, true);
  });

  it("管理员的永久置顶不会被清掉", () => {
    const id = post({ pinned: true, pinnedUntil: null });
    assert.equal(pinSettle.settleExpiredPins().cleared, 0);
    assert.equal(postRow(id).pinned, true);
  });

  it("幂等：跑两遍不会重复通知", () => {
    const id = post();
    buy(id);
    dbm.db
      .update(schema.posts)
      .set({ pinnedUntil: Date.now() - 1 })
      .where(eq(schema.posts.id, id))
      .run();

    pinSettle.settleExpiredPins();
    assert.equal(pinSettle.settleExpiredPins().cleared, 0);
    assert.equal(dbm.db.select().from(schema.notifications).all().length, 1);
  });
});
