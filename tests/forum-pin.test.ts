import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PAID_PIN_SLOTS,
  checkPinPurchase,
  isEffectivelyPinned,
  isPinExpired,
  pinRemainingLabel,
  pinUntil,
} from "@/lib/forum/pin";

/**
 * 置顶。
 *
 * 「置顶了」和「现在还置顶着」是两件事。只看 `pinned` 这个布尔的话，
 * 一次「置顶一天」会变成置顶到天荒地老 —— 而且没有任何地方看得出来：
 * 帖子就在那儿，看起来一切正常。
 */

const NOW = 1_800_000_000_000;
const HOUR = 3600_000;

function state(over: Partial<{ pinned: boolean; pinnedUntil: number | null }> = {}) {
  return { pinned: true, pinnedUntil: NOW + 24 * HOUR, ...over };
}

describe("现在还置顶着吗", () => {
  it("没置顶就是没置顶", () => {
    assert.equal(isEffectivelyPinned(state({ pinned: false }), NOW), false);
    assert.equal(
      isEffectivelyPinned(state({ pinned: false, pinnedUntil: NOW + HOUR }), NOW),
      false,
      "到期时间还在，但布尔是关的",
    );
  });

  it("没有到期时间 = 管理员手动置顶，一直有效", () => {
    assert.equal(isEffectivelyPinned(state({ pinnedUntil: null }), NOW), true);
    assert.equal(isEffectivelyPinned(state({ pinnedUntil: null }), NOW + 365 * 24 * HOUR), true);
  });

  it("**到期之后就不再置顶** —— 这一条之前完全没人判", () => {
    assert.equal(isEffectivelyPinned(state({ pinnedUntil: NOW - 1 }), NOW), false);
    assert.equal(isEffectivelyPinned(state({ pinnedUntil: NOW }), NOW), false, "刚好到点算过期");
    assert.equal(isEffectivelyPinned(state({ pinnedUntil: NOW + 1 }), NOW), true);
  });

  it("认得出「标记还在但已经过期」—— 清理任务靠它", () => {
    assert.equal(isPinExpired(state({ pinnedUntil: NOW - 1 }), NOW), true);
    assert.equal(isPinExpired(state({ pinnedUntil: NOW + HOUR }), NOW), false);
    assert.equal(isPinExpired(state({ pinnedUntil: null }), NOW), false, "手动置顶不会过期");
    assert.equal(isPinExpired(state({ pinned: false }), NOW), false);
  });
});

describe("买置顶的前置检查 —— 全在扣分之前", () => {
  function input(over: Partial<Parameters<typeof checkPinPurchase>[0]> = {}) {
    return checkPinPurchase({
      exists: true,
      authorId: "me",
      buyerId: "me",
      deleted: false,
      status: "published",
      current: { pinned: false, pinnedUntil: null },
      paidPinsInBoard: 0,
      now: NOW,
      ...over,
    });
  }

  it("正常情况放行", () => {
    assert.equal(input().ok, true);
  });

  it("没选帖子 / 帖子不存在", () => {
    const r = input({ exists: false });
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.error : "", /找不到/);
  });

  it("**已经删掉的帖子不能买** —— 扣完钱才发现就得走人工退款", () => {
    assert.equal(input({ deleted: true }).ok, false);
  });

  it("草稿和隐藏的不能买", () => {
    for (const status of ["draft", "hidden", "scheduled"]) {
      assert.equal(input({ status }).ok, false, status);
    }
  });

  it("**只能给自己的帖子买** —— 否则就是花钱把别人的帖子顶上去", () => {
    const r = input({ authorId: "someone_else" });
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.error : "", /自己的帖子/);
  });

  it("已经在置顶的不重复买", () => {
    const r = input({ current: { pinned: true, pinnedUntil: NOW + HOUR } });
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.error : "", /已经在置顶/);
  });

  it("置顶已经过期的可以再买", () => {
    assert.equal(input({ current: { pinned: true, pinnedUntil: NOW - 1 } }).ok, true);
  });

  it("**名额占满就当场拒绝** —— 收了钱却排队比不卖更伤人", () => {
    const r = input({ paidPinsInBoard: PAID_PIN_SLOTS });
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.error : "", /付费置顶位被占着/);
  });

  it("名额是有限的 —— 不限的话第一屏迟早全是买来的", () => {
    assert.ok(PAID_PIN_SLOTS >= 1);
    assert.ok(PAID_PIN_SLOTS <= 2, `${PAID_PIN_SLOTS} 个付费置顶位太多了`);
  });
});

describe("时长与剩余", () => {
  it("按小时顺延", () => {
    assert.equal(pinUntil(24, NOW), NOW + 24 * HOUR);
    assert.equal(pinUntil(1, NOW), NOW + HOUR);
  });

  it("非法时长兜底成 1 小时 —— 配置写成 0 不该等于「永久置顶」", () => {
    assert.equal(pinUntil(0, NOW), NOW + HOUR);
    assert.equal(pinUntil(-5, NOW), NOW + HOUR);
  });

  it("**剩余时间要显示出来** —— 买了的人得知道还剩多少", () => {
    assert.equal(pinRemainingLabel(NOW + 5 * HOUR, NOW), "置顶剩 5 小时");
    assert.equal(pinRemainingLabel(NOW + 30 * 60_000, NOW), "置顶剩 30 分钟");
  });

  it("过期和永久置顶都不显示剩余", () => {
    assert.equal(pinRemainingLabel(NOW - 1, NOW), null);
    assert.equal(pinRemainingLabel(null, NOW), null);
  });

  it("不到一分钟也显示 1 分钟，不显示 0", () => {
    assert.equal(pinRemainingLabel(NOW + 10_000, NOW), "置顶剩 1 分钟");
  });
});
