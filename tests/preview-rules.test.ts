import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  PREVIEW_PERMISSION,
  PREVIEW_TTL_MS,
  PREVIEW_WRITE_BLOCKED,
  canNest,
  minutesLeft,
  planPreview,
  previewActive,
} from "@/lib/rbac/preview-rules";

/**
 * 「以某身份预览」的规则。
 *
 * 这个功能和「变成别人」只差一步，而这一步没走稳会同时给出提权和甩锅
 * 两个后果 —— 两个都比功能本身值钱得多。所以这里测得比别处密。
 */

const viewer = (perms: string[], canImpersonate = true) => ({
  id: "me",
  permissions: perms,
  canImpersonate,
});
const subject = (perms: string[], status = "active") => ({
  id: "them",
  status,
  permissions: perms,
});

describe("权限只减不增", () => {
  it("**他有我没有的，预览里不给** —— 否则这就是一个提权工具", () => {
    const plan = planPreview(viewer(["forum.view"]), subject(["forum.view", "system.settings"]));
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.effective, ["forum.view"]);
    assert.deepEqual(plan.withheld, ["system.settings"]);
  });

  it("**扣掉了什么必须说出来** —— 不说的话我会拿不完整的视角下结论", () => {
    const plan = planPreview(viewer(["a"]), subject(["a", "b", "c"]));
    assert.equal(plan.withheld.length, 2);
    assert.match(plan.reason, /2 项/);
  });

  it("我权限比他全时，预览是完整的，并且要说出来", () => {
    const plan = planPreview(viewer(["a", "b", "c"]), subject(["a", "b"]));
    assert.deepEqual(plan.withheld, []);
    assert.match(plan.reason, /完整/);
  });

  it("我有他没有的权限，**不会漏进预览** —— 预览的是他，不是我", () => {
    const plan = planPreview(viewer(["a", "system.settings"]), subject(["a"]));
    assert.deepEqual(plan.effective, ["a"]);
    assert.equal(plan.effective.includes("system.settings"), false);
  });

  it("他一项权限都没有时也能预览 —— 「新人进站看到什么」正是要看的", () => {
    const plan = planPreview(viewer(["a"]), subject([]));
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.effective, []);
  });

  it("输出是排过序的 —— 免得两次看同一个人顺序不一样", () => {
    const plan = planPreview(viewer(["b", "a", "c"]), subject(["c", "a", "b"]));
    assert.deepEqual(plan.effective, ["a", "b", "c"]);
  });

  it("重复的权限点不会让计数虚高", () => {
    const plan = planPreview(viewer([]), subject(["x", "x", "x"]));
    assert.deepEqual(plan.withheld, ["x"]);
  });
});

describe("谁不能被预览", () => {
  it("没有那个权限点就开不了", () => {
    const plan = planPreview(viewer(["a"], false), subject(["a"]));
    assert.equal(plan.ok, false);
    assert.match(plan.reason, /没有.*权限/);
  });

  it("不能预览自己", () => {
    const plan = planPreview({ id: "same", permissions: [], canImpersonate: true }, {
      id: "same",
      status: "active",
      permissions: [],
    });
    assert.equal(plan.ok, false);
  });

  it("**封禁账号不给预览** —— 切过去只会看到一片空白，而空白和「权限配错了」长得一样", () => {
    for (const status of ["banned", "deleted"]) {
      const plan = planPreview(viewer(["a"]), subject(["a"], status));
      assert.equal(plan.ok, false, `${status} 竟然可以预览`);
      assert.match(plan.reason, /封禁|注销/);
    }
  });

  it("失败时不返回任何权限 —— 别让调用方拿着一份「失败但有权限」的结果", () => {
    const plan = planPreview(viewer(["a"], false), subject(["a", "b"]));
    assert.deepEqual(plan.effective, []);
    assert.deepEqual(plan.withheld, []);
  });
});

describe("**不能套娃**", () => {
  it("预览态里再开一个预览是不行的", () => {
    /*
     * 套娃之后「我现在到底是谁」说不清了，
     * 而说不清的时候人会默认自己是自己 —— 那正是出事的那一刻。
     */
    assert.equal(canNest(), false);
  });
});

describe("会过期", () => {
  it("有效期是 30 分钟 —— 这是一次查看，不是一个工作模式", () => {
    assert.equal(PREVIEW_TTL_MS, 30 * 60_000);
  });

  it("过了点就无效", () => {
    assert.equal(previewActive(1000, 999), true);
    assert.equal(previewActive(1000, 1000), false);
    assert.equal(previewActive(1000, 1001), false);
  });

  it("倒计时向上取整，最后一分钟不显示 0", () => {
    assert.equal(minutesLeft(60_001, 0), 2);
    assert.equal(minutesLeft(60_000, 0), 1);
    assert.equal(minutesLeft(1, 0), 1);
    assert.equal(minutesLeft(0, 0), 0);
    assert.equal(minutesLeft(-5_000, 0), 0, "过期了显示负数");
  });
});

describe("**判定要说真话，执行才拦**", () => {
  it("规则模块不认识「写操作」这个概念 —— 它只管权限，不管拦截", () => {
    /*
     * 这条断言锁的是设计本身。
     *
     * 最容易走反的一步：既然预览不许写，那把写权限在预览里判成「没有」
     * 不就完了？不行 —— 这个功能存在的理由就是回答
     * 「版主到底能不能删别人的帖」。判成没有的话删除按钮不出现，
     * 管理员一眼就得出「版主不能删」，而这是错的。
     *
     * 所以 planPreview 只做交集，绝不因为「这是个写权限」而扣掉它。
     */
    const plan = planPreview(
      viewer(["forum.post.delete.any"]),
      subject(["forum.post.delete.any"]),
    );
    assert.deepEqual(
      plan.effective,
      ["forum.post.delete.any"],
      "写权限被规则层扣掉了 —— 那预览出来的视角是假的",
    );
  });

  it("拦截的说法整站只有一处，不许各页各写一句", () => {
    assert.match(PREVIEW_WRITE_BLOCKED, /预览/);
    assert.match(PREVIEW_WRITE_BLOCKED, /没有执行/);
  });
});

describe("这个权限点本身", () => {
  const perms = readFileSync(new URL("../src/lib/rbac/permissions.ts", import.meta.url), "utf8");

  it("已经登记在权限表里，而且是最高危等级", () => {
    assert.ok(perms.includes(`key: "${PREVIEW_PERMISSION}"`));
    const block = perms.slice(perms.indexOf(`key: "${PREVIEW_PERMISSION}"`));
    assert.match(block.slice(0, 400), /dangerLevel: 3/);
  });
});

describe("规则层不碰任何 IO", () => {
  it("纯函数 —— 不 import 数据库、cookie 或 server-only", () => {
    /*
     * 这不是洁癖。规则一旦能读库，测试就得起一个库，
     * 而这一层正是最需要密集测试的一层 —— 它决定谁能变成谁。
     */
    const src = readFileSync(new URL("../src/lib/rbac/preview-rules.ts", import.meta.url), "utf8");
    for (const forbidden of ["server-only", "@/lib/db", "next/headers", "drizzle-orm"]) {
      assert.equal(src.includes(forbidden), false, `规则层引了 ${forbidden}`);
    }
  });
});
