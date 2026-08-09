import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canTransitionOrder,
  checkItem,
  checkPurchase,
  checkRefund,
  isInstantDelivery,
  itemKindLabel,
  orderStatusLabel,
  remainingStock,
} from "@/lib/shop/rules";

/**
 * 商店的判定。
 *
 * 商店在这套系统里是**积分的主要回收口** —— 只发不收的积分
 * 一年后必然废掉。所以规则要同时管两头：
 * 别让用户买到买不了的东西，也别让积分凭空消失或凭空出现。
 * 后者更要命：扣了分没下单、退款退出两份，事后都极难查清。
 */

describe("兑换校验", () => {
  const base = {
    enabled: true,
    price: 300,
    stock: 10,
    sold: 3,
    perUserLimit: 1,
    ownedCount: 0,
    balance: 500,
    kind: "title" as const,
    hasShipping: false,
  };

  it("条件齐全时可以买", () => {
    assert.equal(checkPurchase(base).ok, true);
  });

  it("下架的买不了", () => {
    assert.equal(checkPurchase({ ...base, enabled: false }).ok, false);
  });

  it("卖完了就买不了", () => {
    assert.equal(checkPurchase({ ...base, sold: 10 }).ok, false);
  });

  it("不限量的永远有货", () => {
    assert.equal(checkPurchase({ ...base, stock: null, sold: 99_999 }).ok, true);
  });

  it("**余额不够时说清楚还差多少**", () => {
    const r = checkPurchase({ ...base, balance: 100 });
    assert.equal(r.ok, false);
    assert.match(r.error!, /还差 200 分/);
  });

  it("刚好够也能买", () => {
    assert.equal(checkPurchase({ ...base, balance: 300 }).ok, true);
  });

  it("超过限购次数买不了", () => {
    assert.equal(checkPurchase({ ...base, ownedCount: 1 }).ok, false);
  });

  it("不限购时买几次都行", () => {
    assert.equal(checkPurchase({ ...base, perUserLimit: null, ownedCount: 50 }).ok, true);
  });

  it("**实物商品没填地址就不给下单**", () => {
    // 下单成功再问地址的话，会出现一批「已付款但发不出去」的订单，
    // 而那时积分已经扣了
    const r = checkPurchase({ ...base, kind: "physical", hasShipping: false });
    assert.equal(r.ok, false);
    assert.match(r.error!, /收货/);
  });

  it("实物商品填了地址就能买", () => {
    assert.equal(checkPurchase({ ...base, kind: "physical", hasShipping: true }).ok, true);
  });

  it("没定价的买不了 —— 不能因为配置漏填就变成白送", () => {
    assert.equal(checkPurchase({ ...base, price: 0 }).ok, false);
  });
});

describe("交付方式", () => {
  it("虚拟商品兑换即交付", () => {
    for (const k of ["title", "makeup_card", "highlight", "custom"] as const) {
      assert.equal(isInstantDelivery(k), true, `${k} 应该即时交付`);
    }
  });

  it("实物要走发货流程", () => {
    assert.equal(isInstantDelivery("physical"), false);
  });
});

describe("订单状态机", () => {
  it("实物的正常路径", () => {
    assert.equal(canTransitionOrder("pending", "shipping").ok, true);
    assert.equal(canTransitionOrder("shipping", "delivered").ok, true);
  });

  it("虚拟商品直接到已交付", () => {
    assert.equal(canTransitionOrder("pending", "fulfilled").ok, true);
  });

  it("**已签收之后不再退** —— 东西已经在对方手里了", () => {
    assert.equal(canTransitionOrder("delivered", "refunded").ok, false);
  });

  it("已交付的虚拟商品仍可退（比如发错了）", () => {
    assert.equal(canTransitionOrder("fulfilled", "refunded").ok, true);
  });

  it("退过的不能再退", () => {
    assert.equal(canTransitionOrder("refunded", "refunded").ok, false);
    assert.equal(canTransitionOrder("refunded", "fulfilled").ok, false);
  });

  it("取消是终态", () => {
    assert.equal(canTransitionOrder("cancelled", "fulfilled").ok, false);
  });
});

describe("退款", () => {
  const base = { status: "pending" as const, ledgerId: "led1", reason: "货没了" };

  it("正常退款通过", () => {
    assert.equal(checkRefund(base).ok, true);
  });

  it("必须写原因", () => {
    assert.equal(checkRefund({ ...base, reason: " " }).ok, false);
  });

  it("**没有扣分流水就退不了**", () => {
    // 退款是冲正那一笔扣分，不是凭空加。凭空加的话积分总量会悄悄多出来，
    // 而通胀体检看到「有人白拿了分」却查不出源头
    const r = checkRefund({ ...base, ledgerId: null });
    assert.equal(r.ok, false);
    assert.match(r.error!, /人工处理/);
  });

  it("已签收的退不了", () => {
    assert.equal(checkRefund({ ...base, status: "delivered" }).ok, false);
  });
});

describe("库存显示", () => {
  it("算得出还剩几件", () => {
    assert.equal(remainingStock(10, 3), 7);
  });

  it("**不限量时返回 null 而不是 0**", () => {
    // 0 会被显示成「卖完了」，那是完全相反的意思
    assert.equal(remainingStock(null, 999), null);
  });

  it("超卖时不会算成负数", () => {
    assert.equal(remainingStock(5, 8), 0);
  });
});

describe("商品配置校验", () => {
  const base = {
    key: "custom_title",
    name: "自定义称号",
    price: 300,
    stock: null,
    perUserLimit: 1,
    kind: "title" as const,
    config: { titleKey: "custom_monthly" },
  };

  it("正常商品通过", () => {
    assert.equal(checkItem(base).ok, true);
  });

  it("标识只能用小写字母数字与连字符", () => {
    assert.equal(checkItem({ ...base, key: "Custom Title" }).ok, false);
    assert.equal(checkItem({ ...base, key: "中文标识" }).ok, false);
  });

  it("价格必须是正整数", () => {
    assert.equal(checkItem({ ...base, price: 0 }).ok, false);
    assert.equal(checkItem({ ...base, price: -1 }).ok, false);
    assert.equal(checkItem({ ...base, price: 1.5 }).ok, false);
  });

  it("库存可以是 0（暂时缺货）但不能是负数", () => {
    assert.equal(checkItem({ ...base, stock: 0 }).ok, true);
    assert.equal(checkItem({ ...base, stock: -1 }).ok, false);
  });

  it("**称号类商品必须指定发哪个称号**", () => {
    // 不指定的话兑换会成功但交付会失败 ——
    // 那时积分已经扣了，而用户什么都没拿到
    const r = checkItem({ ...base, config: {} });
    assert.equal(r.ok, false);
    assert.match(r.error!, /称号/);
  });

  it("补签卡张数必须是正整数", () => {
    assert.equal(
      checkItem({ ...base, kind: "makeup_card", config: { count: 0 } }).ok,
      false,
    );
    assert.equal(
      checkItem({ ...base, kind: "makeup_card", config: { count: 3 } }).ok,
      true,
    );
  });

  it("补签卡不填张数时按 1 张算，不报错", () => {
    assert.equal(checkItem({ ...base, kind: "makeup_card", config: {} }).ok, true);
  });
});

describe("展示文案", () => {
  it("订单状态都有中文名", () => {
    for (const s of ["pending", "fulfilled", "shipping", "delivered", "cancelled", "refunded"]) {
      assert.notEqual(orderStatusLabel(s), s, `${s} 没有中文名`);
    }
  });

  it("商品类型都有中文名", () => {
    for (const k of ["title", "makeup_card", "highlight", "physical"]) {
      assert.notEqual(itemKindLabel(k), k, `${k} 没有中文名`);
    }
  });

  it("未知值原样返回", () => {
    assert.equal(orderStatusLabel("weird"), "weird");
    assert.equal(itemKindLabel("weird"), "weird");
  });
});
