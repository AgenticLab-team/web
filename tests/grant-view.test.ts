import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  filterPersonGrants,
  mergeGrantsByUser,
  paginate,
  type FlatGrant,
} from "@/lib/api-tokens/grant-view";

import { readCode } from "./_source";

/**
 * 授权列表的合并、过滤、分页。
 *
 * ═════════════════════════════════════════
 * 合并这件事**能在界面上说假话**
 * ═════════════════════════════════════════
 *
 * 库里存的是逐群的行（一个群一行、一条审计、单独收回），那是对的。
 * 合并只发生在显示层 —— 而合并的风险是把差异一起合掉：
 * 同一个人的十二个群里有一个被单独调到「每天 2 条」，
 * 合成一句「每天 60 条」看起来非常整齐，而它是假的。
 *
 * 整齐的假话最难被发现，所以这一组测试主要在盯这一点。
 */

function grant(over: Partial<FlatGrant> = {}): FlatGrant {
  return {
    convId: "a@chatroom",
    convName: "A 群",
    userId: "u1",
    userName: "小明",
    reason: "维护打卡机器人",
    perMinute: null,
    perHour: null,
    perDay: null,
    createdAt: 1000,
    ...over,
  };
}

describe("按人合并", () => {
  it("一个人的多个群合成一张卡", () => {
    const out = mergeGrantsByUser([
      grant({ convId: "a@chatroom", convName: "A 群" }),
      grant({ convId: "b@chatroom", convName: "B 群" }),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].groups.length, 2);
  });

  it("不同的人不合并", () => {
    const out = mergeGrantsByUser([
      grant({ userId: "u1", userName: "小明" }),
      grant({ userId: "u2", userName: "小红" }),
    ]);
    assert.equal(out.length, 2);
  });

  it("**理由一致才合成一句**", () => {
    const same = mergeGrantsByUser([
      grant({ convId: "a@chatroom", reason: "维护打卡机器人" }),
      grant({ convId: "b@chatroom", reason: "维护打卡机器人" }),
    ]);
    assert.equal(same[0].uniformReason, "维护打卡机器人");
    assert.equal(same[0].mixed, false);
  });

  it("**理由不一致就不合** —— 合成一句等于在界面上说假话", () => {
    const diff = mergeGrantsByUser([
      grant({ convId: "a@chatroom", reason: "维护打卡机器人" }),
      grant({ convId: "b@chatroom", reason: "临时帮忙发通知" }),
    ]);
    assert.equal(diff[0].uniformReason, null);
    assert.equal(diff[0].mixed, true, "不一致时必须让界面逐群列");
  });

  it("**额度被单独调紧过，就不能显示成统一额度**", () => {
    /*
     * 这是最危险的一种：站长把某个群调到每天 2 条，
     * 而卡片上写着「每天 60 条」—— 他会以为那个限制没生效。
     */
    const out = mergeGrantsByUser([
      grant({ convId: "a@chatroom", perDay: null }),
      grant({ convId: "b@chatroom", perDay: 2 }),
    ]);
    assert.equal(out[0].uniformPerDay, null);
    assert.equal(out[0].mixed, true);
    assert.equal(out[0].groups.find((g) => g.convId === "b@chatroom")?.perDay, 2);
  });

  it("额度都一样时给出那个值（包括都是 null）", () => {
    const out = mergeGrantsByUser([
      grant({ convId: "a@chatroom", perDay: 5 }),
      grant({ convId: "b@chatroom", perDay: 5 }),
    ]);
    assert.equal(out[0].uniformPerDay, 5);
    assert.equal(out[0].mixed, false);
  });

  it("名字缺一行时取另一行，不是直接显示 id", () => {
    // 账号刚建、昵称还没同步时会出现空名字
    const out = mergeGrantsByUser([
      grant({ convId: "a@chatroom", userName: null }),
      grant({ convId: "b@chatroom", userName: "小明" }),
    ]);
    assert.equal(out[0].userName, "小明");
  });

  it("全都没名字才退回 id", () => {
    const out = mergeGrantsByUser([grant({ userName: null })]);
    assert.equal(out[0].userName, "u1");
  });

  it("群没了也要显示 id —— 至少看得出是哪个群", () => {
    const out = mergeGrantsByUser([grant({ convName: null, convId: "gone@chatroom" })]);
    assert.equal(out[0].groups[0].convName, "gone@chatroom");
  });

  it("最近授权的排前面", () => {
    const out = mergeGrantsByUser([
      grant({ userId: "old", createdAt: 100 }),
      grant({ userId: "new", createdAt: 900 }),
    ]);
    assert.deepEqual(
      out.map((p) => p.userId),
      ["new", "old"],
    );
  });

  it("空输入不炸", () => {
    assert.deepEqual(mergeGrantsByUser([]), []);
  });
});

describe("过滤", () => {
  const people = mergeGrantsByUser([
    grant({ userId: "u1", userName: "小明", convId: "a@chatroom", convName: "研发群" }),
    grant({ userId: "u1", userName: "小明", convId: "b@chatroom", convName: "闲聊群" }),
    grant({ userId: "u2", userName: "小红", convId: "c@chatroom", convName: "运营群", reason: "发日报" }),
  ]);

  it("搜人名", () => {
    assert.deepEqual(filterPersonGrants(people, "小红").map((p) => p.userName), ["小红"]);
  });

  it("搜理由", () => {
    assert.deepEqual(filterPersonGrants(people, "日报").map((p) => p.userName), ["小红"]);
  });

  it("**搜群名时保留整个人，不是只留匹配的群**", () => {
    /*
     * 只留匹配的群，那张卡看起来像「他只有研发群」——
     * 于是站长以为可以放心，实际上他还有闲聊群。
     * 而「谁能往这个群发」正是搜群名时要问的问题。
     */
    const hit = filterPersonGrants(people, "研发");
    assert.equal(hit.length, 1);
    assert.equal(hit[0].groups.length, 2, "匹配到一个群，整个人的群都要留着");
  });

  it("空查询原样返回", () => {
    assert.equal(filterPersonGrants(people, "   ").length, people.length);
  });

  it("大小写不敏感", () => {
    const list = mergeGrantsByUser([grant({ userName: "Alice" })]);
    assert.equal(filterPersonGrants(list, "alice").length, 1);
  });
});

describe("分页", () => {
  const items = Array.from({ length: 23 }, (_, i) => i);

  it("切得对", () => {
    const p = paginate(items, 2, 10);
    assert.deepEqual(p.items, [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    assert.equal(p.pages, 3);
    assert.equal(p.total, 23);
  });

  it("**页码越界要夹回来，不是给一页空的**", () => {
    /*
     * 停在第 5 页，前面被收回了几条，总数缩到 3 页 ——
     * 刷新一下得到一张空白页面，而人第一反应是「东西没了」。
     * 过滤之后更常撞上：停在第 3 页时打两个字。
     */
    const p = paginate(items, 99, 10);
    assert.equal(p.page, 3);
    assert.equal(p.items.length, 3);
  });

  it("小于 1 的页码也夹回来", () => {
    assert.equal(paginate(items, 0, 10).page, 1);
    assert.equal(paginate(items, -5, 10).page, 1);
    // 地址栏里什么都可能有
    assert.equal(paginate(items, Number.NaN, 10).page, 1);
  });

  it("一条都没有时仍然是第 1 页共 1 页，不是第 1 页共 0 页", () => {
    const p = paginate([], 1, 10);
    assert.equal(p.pages, 1);
    assert.equal(p.total, 0);
    assert.deepEqual(p.items, []);
  });
});

describe("日志的过滤走的是 SQL", () => {
  const store = readCode("lib/api-tokens/store.ts");

  it("**筛选和分页都落在库里**，不是查出来再切", () => {
    /*
     * 查出来再 filter 的话，「第 2 页」是在**已经被截断的结果**上分的，
     * 而总数也会是错的 —— 那种错看起来很正常：数字小一点而已。
     */
    const fn = store.slice(store.indexOf("export function sendLog"));
    assert.match(fn.slice(0, 2200), /\.limit\(/);
    assert.match(fn.slice(0, 2200), /\.offset\(/);
    assert.match(fn.slice(0, 2200), /count\(\*\)/);
  });

  it("**LIKE 里的通配符要转义** —— 不转的话搜下划线等于匹配任意字符", () => {
    assert.match(store, /function escapeLike/);
    assert.match(store, /ESCAPE/);
  });

  it("「我的」那一页不能从地址栏取 userId", () => {
    /*
     * 从地址栏取的话，改一个参数就能看别人代发了什么 ——
     * 而代发日志里存的是完整正文。
     */
    const page = readCode("app/(app)/me/api/page.tsx");
    const call = page.slice(page.indexOf("const log = sendLog("), page.indexOf("logPages"));
    assert.match(call, /userId:\s*user\.id/);
    assert.equal(/userId:\s*(one|sp)\(/.test(call), false);
  });
});
