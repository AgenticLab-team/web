import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

/**
 * 兑换与退款。
 *
 * 这里最要紧的不是「能不能买」，是**积分不能凭空消失或凭空出现**。
 * 扣了分没下单、退款退出两份，事后都极难查清 ——
 * 用户只知道「我的分少了 300」，而流水里看不出为什么。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-shop-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

type Purchase = typeof import("@/lib/shop/purchase");
type Ledger = typeof import("@/lib/points/ledger");
type DbModule = typeof import("@/lib/db");
type SchemaModule = typeof import("@/lib/db/schema");

let shop: Purchase;
let ledger: Ledger;
let dbm: DbModule;
let schema: SchemaModule;

const USER = "u_buyer";

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  shop = await import("@/lib/shop/purchase");
  ledger = await import("@/lib/points/ledger");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  for (const t of [
    schema.makeupCards,
    schema.orders,
    schema.shopItems,
    schema.userTitles,
    schema.titles,
    schema.pointsLedger,
    schema.users,
  ]) {
    dbm.db.delete(t).run();
  }

  /*
   * 初始积分必须**走流水**发放，不能直接写 points 列。
   * 直接写的话余额与流水从一开始就对不上，
   * 而 auditBalance 正是用来发现这种不一致的 —— 那样测的就不是代码了。
   */
  dbm.db.insert(schema.users).values({ id: USER, wxId: "wx_b", siteNickname: "买家" }).run();
  ledger.grantPoints({
    userId: USER,
    delta: 1000,
    reason: "测试初始积分",
    idempotencyKey: "seed",
  });
});

function item(over: Record<string, unknown> = {}) {
  dbm.db
    .insert(schema.shopItems)
    .values({
      id: "item1",
      key: "makeup",
      kind: "makeup_card",
      name: "补签卡",
      price: 200,
      stock: 5,
      perUserLimit: null,
      enabled: true,
      config: { count: 1 },
      ...over,
    })
    .run();
}

function balance(): number {
  return dbm.db.select().from(schema.users).where(eq(schema.users.id, USER)).get()!.points;
}

let seq = 0;
function buy(over: Record<string, unknown> = {}) {
  return shop.purchaseItem({
    userId: USER,
    itemKey: "makeup",
    balance: balance(),
    idempotencyKey: `test:${++seq}`,
    ...over,
  });
}

describe("正常兑换", () => {
  it("扣分、下单、交付一次完成", () => {
    item();
    const r = buy();

    assert.equal(r.ok, true);
    assert.equal(balance(), 800);

    const order = dbm.db.select().from(schema.orders).get()!;
    assert.equal(order.status, "fulfilled", "虚拟商品兑换即交付");
    assert.equal(order.pricePaid, 200);
    assert.ok(order.ledgerId, "必须记下扣分流水 —— 没有它就退不了款");
  });

  it("补签卡真的到账了", () => {
    item({ config: { count: 3 } });
    buy();
    assert.equal(dbm.db.select().from(schema.makeupCards).all().length, 3);
  });

  it("**流水与余额始终对得上**", () => {
    item();
    buy();
    assert.equal(ledger.auditBalance(USER).consistent, true);
  });

  it("库存跟着减", () => {
    item();
    buy();
    assert.equal(dbm.db.select().from(schema.shopItems).get()!.sold, 1);
  });
});

describe("买不了的情况", () => {
  it("余额不够时**一分都不扣**", () => {
    item({ price: 9999 });
    const r = buy();

    assert.equal(r.ok, false);
    assert.equal(balance(), 1000, "买失败不该动余额");
    assert.equal(dbm.db.select().from(schema.orders).all().length, 0);
  });

  it("**买失败时库存也不该少**", () => {
    // 少了的话，一次失败的点击会让一件商品永远卖不出去
    item({ price: 9999 });
    buy();
    assert.equal(dbm.db.select().from(schema.shopItems).get()!.sold, 0);
  });

  it("下架的买不了", () => {
    item({ enabled: false });
    assert.equal(buy().ok, false);
    assert.equal(balance(), 1000);
  });

  it("**卖完之后再买不会超卖**", () => {
    item({ stock: 2 });
    buy();
    buy();
    const third = buy();

    assert.equal(third.ok, false);
    assert.equal(dbm.db.select().from(schema.shopItems).get()!.sold, 2);
    assert.equal(balance(), 600, "第三次不该扣分");
  });

  it("超过限购次数买不了", () => {
    item({ perUserLimit: 1 });
    buy();
    assert.equal(buy().ok, false);
    assert.equal(balance(), 800);
  });

  it("商品不存在时不炸", () => {
    assert.equal(buy().ok, false);
  });
});

describe("幂等", () => {
  it("**同一个键重复提交不会扣两次分**", () => {
    item();
    const first = shop.purchaseItem({
      userId: USER,
      itemKey: "makeup",
      balance: balance(),
      idempotencyKey: "same-click",
    });
    const second = shop.purchaseItem({
      userId: USER,
      itemKey: "makeup",
      balance: balance(),
      idempotencyKey: "same-click",
    });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true, "重复提交当成功处理，不是报错");
    assert.equal(balance(), 800, "只该扣一次");
    assert.equal(dbm.db.select().from(schema.orders).all().length, 1);
  });

  it("重复提交也不会重复扣库存", () => {
    item();
    for (let i = 0; i < 3; i++) {
      shop.purchaseItem({
        userId: USER,
        itemKey: "makeup",
        balance: balance(),
        idempotencyKey: "same-click",
      });
    }
    assert.equal(dbm.db.select().from(schema.shopItems).get()!.sold, 1);
  });
});

describe("实物商品", () => {
  it("没填地址买不了", () => {
    item({ kind: "physical" });
    assert.equal(buy().ok, false);
  });

  it("填了地址下单成功，但状态是待处理而不是已交付", () => {
    item({ kind: "physical" });
    const r = buy({ shipping: { name: "甲", address: "某处" } });

    assert.equal(r.ok, true);
    assert.equal(dbm.db.select().from(schema.orders).get()!.status, "pending");
  });
});

describe("退款", () => {
  it("**走冲正而不是凭空加分**", () => {
    item();
    buy();

    const r = shop.refundOrder({
      orderId: dbm.db.select().from(schema.orders).get()!.id,
      reason: "货没了",
      operatorId: "u_admin",
    });

    assert.equal(r.ok, true);
    assert.equal(balance(), 1000);

    // 兑换那一笔和冲正那一笔并存 —— 原记录不该被改动
    const shopEntries = dbm.db
      .select()
      .from(schema.pointsLedger)
      .all()
      .filter((e) => e.idempotencyKey !== "seed");

    assert.equal(shopEntries.length, 2, "应该是一扣一冲两条，而不是改掉原来那条");
    assert.equal(shopEntries.filter((e) => e.delta === -200).length, 1);
    assert.equal(shopEntries.filter((e) => e.delta === 200).length, 1);
    assert.equal(ledger.auditBalance(USER).consistent, true);
  });

  it("**退款把库存还回去** —— 否则退一单就少一件永远卖不出去", () => {
    item({ stock: 5 });
    buy();
    assert.equal(dbm.db.select().from(schema.shopItems).get()!.sold, 1);

    shop.refundOrder({
      orderId: dbm.db.select().from(schema.orders).get()!.id,
      reason: "退",
      operatorId: "u_admin",
    });
    assert.equal(dbm.db.select().from(schema.shopItems).get()!.sold, 0);
  });

  it("**不会退两次**", () => {
    item();
    buy();
    const orderId = dbm.db.select().from(schema.orders).get()!.id;

    assert.equal(shop.refundOrder({ orderId, reason: "一", operatorId: "u_admin" }).ok, true);
    assert.equal(shop.refundOrder({ orderId, reason: "二", operatorId: "u_admin" }).ok, false);
    assert.equal(balance(), 1000, "退两次的话余额会变成 1200");
  });

  it("退款要写原因", () => {
    item();
    buy();
    const orderId = dbm.db.select().from(schema.orders).get()!.id;
    assert.equal(shop.refundOrder({ orderId, reason: "  ", operatorId: "u_admin" }).ok, false);
  });

  it("订单不存在时如实报错", () => {
    assert.equal(
      shop.refundOrder({ orderId: "没有", reason: "退", operatorId: "u_admin" }).ok,
      false,
    );
  });
});

describe("库存对账", () => {
  it("正常情况下卖出数与有效订单数一致", () => {
    item();
    buy();
    buy();
    assert.equal(shop.auditStock("item1").consistent, true);
  });

  it("**有人直接改库时查得出来**", () => {
    item();
    buy();
    dbm.db.update(schema.shopItems).set({ sold: 42 }).where(eq(schema.shopItems.id, "item1")).run();

    const audit = shop.auditStock("item1");
    assert.equal(audit.consistent, false);
    assert.equal(audit.computed, 1);
  });

  it("退款过的订单不计入有效数", () => {
    item();
    buy();
    shop.refundOrder({
      orderId: dbm.db.select().from(schema.orders).get()!.id,
      reason: "退",
      operatorId: "u_admin",
    });
    assert.equal(shop.auditStock("item1").consistent, true);
  });
});

describe("称号类商品", () => {
  beforeEach(() => {
    dbm.db
      .insert(schema.titles)
      .values({ id: "t1", key: "custom_monthly", name: "自定义称号", rarity: "rare", source: "purchase" })
      .run();
  });

  it("兑换后称号到账", () => {
    item({ kind: "title", config: { titleKey: "custom_monthly" } });
    buy();

    const held = dbm.db.select().from(schema.userTitles).get();
    assert.ok(held);
    assert.equal(held!.userId, USER);
  });

  it("**配置指向不存在的称号时，订单留下待人工处理而不是回滚**", () => {
    // 回滚的话用户会以为「没买成」然后再点一次，而分其实已经扣过了
    item({ kind: "title", config: { titleKey: "不存在" } });
    const r = buy();

    assert.equal(r.ok, true);
    const order = dbm.db.select().from(schema.orders).get()!;
    assert.match(JSON.stringify(order.fulfillResult), /人工处理/);
  });

  it("已经有这个称号时不重复发，留待人工处理", () => {
    dbm.db.insert(schema.userTitles).values({ userId: USER, titleId: "t1" }).run();
    item({ kind: "title", config: { titleKey: "custom_monthly" }, perUserLimit: null });

    buy();
    assert.equal(dbm.db.select().from(schema.userTitles).all().length, 1);
  });
});
