import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ACTION_LABELS,
  BULK_LIMIT,
  actionLabel,
  checkBulk,
  distinctAuthors,
  isDestructive,
  summarize,
  type BulkAction,
} from "@/lib/moderation/bulk-rules";

/**
 * 批量操作。
 *
 * 这是后台里**最容易造成不可逆损失**的功能：全选一下、点一次删除，
 * 两百篇内容和它们背后两百个人的心血就没了。
 * 而且做错之后往往没人立刻发现 —— 内容消失是安静的。
 */

describe("批量校验", () => {
  const base = { ids: ["p1", "p2"], action: "hide" as BulkAction, reason: "连续刷广告" };

  it("正常批量通过", () => {
    assert.equal(checkBulk(base).ok, true);
  });

  it("一条都没选时拒绝", () => {
    assert.equal(checkBulk({ ...base, ids: [] }).ok, false);
  });

  it("**超过上限时拒绝，并说清楚选了多少**", () => {
    const ids = Array.from({ length: BULK_LIMIT + 1 }, (_, i) => `p${i}`);
    const r = checkBulk({ ...base, ids });
    assert.equal(r.ok, false);
    assert.match(r.error!, new RegExp(String(BULK_LIMIT)));
    assert.match(r.error!, /分批/);
  });

  it("刚好等于上限可以", () => {
    const ids = Array.from({ length: BULK_LIMIT }, (_, i) => `p${i}`);
    assert.equal(checkBulk({ ...base, ids }).ok, true);
  });

  it("必须填理由", () => {
    assert.equal(checkBulk({ ...base, reason: "  " }).ok, false);
  });

  it("**破坏性操作的理由要长一点**", () => {
    // 「违规」两个字在三个月后的申诉里毫无价值 ——
    // 当事人看不出自己做错了什么，处理的人也回忆不起来
    assert.equal(checkBulk({ ...base, action: "delete", reason: "违规" }).ok, false);
    assert.equal(checkBulk({ ...base, action: "hide", reason: "违规" }).ok, false);
    assert.equal(checkBulk({ ...base, action: "delete", reason: "重复发布广告" }).ok, true);
  });

  it("非破坏性操作不强求长理由", () => {
    assert.equal(checkBulk({ ...base, action: "feature", reason: "好帖" }).ok, true);
  });

  it("**选中项里有重复时拒绝** —— 会导致重复留痕和重复通知", () => {
    assert.equal(checkBulk({ ...base, ids: ["p1", "p1"] }).ok, false);
  });
});

describe("破坏性判定", () => {
  it("删除和隐藏是破坏性的", () => {
    assert.equal(isDestructive("delete"), true);
    assert.equal(isDestructive("hide"), true);
  });

  it("恢复、加精、锁定不是", () => {
    assert.equal(isDestructive("restore"), false);
    assert.equal(isDestructive("feature"), false);
    assert.equal(isDestructive("lock"), false);
  });

  it("未知动作按不破坏处理，但它会在别处被拒", () => {
    assert.equal(isDestructive("nuke"), false);
  });
});

describe("结果汇总", () => {
  it("全部成功", () => {
    const r = summarize(
      [
        { id: "a", ok: true },
        { id: "b", ok: true },
      ],
      "隐藏",
    );
    assert.equal(r.succeeded, 2);
    assert.equal(r.failed.length, 0);
    assert.match(r.message, /已隐藏 2 条/);
  });

  it("**部分失败必须被点名**", () => {
    // 只报「成功 47 条」的话，剩下 3 条到底怎么了没人知道，
    // 而那 3 条往往正是有问题的那几条
    const r = summarize(
      [
        { id: "a", ok: true },
        { id: "b", ok: false, error: "帖子不存在" },
      ],
      "删除",
    );
    assert.equal(r.succeeded, 1);
    assert.equal(r.failed.length, 1);
    assert.match(r.message, /1 条失败/);
    assert.match(r.message, /帖子不存在/);
  });

  it("全部失败时说清楚", () => {
    const r = summarize([{ id: "a", ok: false, error: "没有权限" }], "删除");
    assert.equal(r.succeeded, 0);
    assert.match(r.message, /全部失败/);
    assert.match(r.message, /没有权限/);
  });

  it("失败但没给原因时不会显示 undefined", () => {
    const r = summarize([{ id: "a", ok: false }], "删除");
    assert.ok(!r.message.includes("undefined"));
  });

  it("空结果不炸", () => {
    const r = summarize([], "隐藏");
    assert.equal(r.total, 0);
    assert.equal(r.succeeded, 0);
  });
});

describe("影响面", () => {
  it("**统计的是人数不是条数**", () => {
    // 界面上说「影响 2 位作者」而不只是「3 条内容」——
    // 前者才让人意识到这是在动别人的东西
    const items = [{ authorId: "u1" }, { authorId: "u1" }, { authorId: "u2" }];
    assert.equal(distinctAuthors(items), 2);
  });

  it("空集合是 0", () => {
    assert.equal(distinctAuthors([]), 0);
  });
});

describe("动作文案", () => {
  it("每个动作都有中文名", () => {
    for (const key of Object.keys(ACTION_LABELS)) {
      assert.ok(ACTION_LABELS[key as BulkAction].length > 0, `${key} 没有中文名`);
    }
  });

  it("未知动作原样返回，不显示 undefined", () => {
    assert.equal(actionLabel("nuke"), "nuke");
  });
});
