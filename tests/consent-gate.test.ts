import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { consentGate } from "@/lib/forum/consent-gate";
import { readCode } from "./_source";

/**
 * 「能不能把这篇群聊转帖放得更开」。
 *
 * ─────────────────────────────────────────
 * 这个站最硬的一条约束，此前一条测试都没有
 * ─────────────────────────────────────────
 *
 * 群里说的话进论坛，原作者同意的是「给这个群看」。往外放一档，
 * 必须每一位被引用到的人都点过头。
 *
 * 一次变异普查里，`raiseVisibility()` 里那两行同意判定被改掉之后
 * **全量测试一条都不红** —— 查下来那个函数在整个 tests/ 里
 * 一次都没有出现过。它带 `"use server"`、开头就要 `getCurrentUser()`，
 * 于是从来没人测过它。
 *
 * 判定因此拆成了 `consentGate`，**并且真的被 raiseVisibility 调用**
 * （不是复述一遍 —— 那种「写在没人问的地方的规则」这个仓库刚清过一批）。
 *
 * ─────────────────────────────────────────
 * 最要紧的一条：denied 必须和 pending 一样拦下
 * ─────────────────────────────────────────
 *
 * 只数 pending 的话，一个**明确拒绝过**的人会被当成「已经处理完了」，
 * 而他的发言照样被公开出去 —— 那正是这条约束要防的那一种情况。
 */

const entry = (status: "pending" | "granted" | "denied") => ({ status });

describe("同意闸门", () => {
  it("**全体同意才放行**", () => {
    const gate = consentGate([entry("granted"), entry("granted")]);
    assert.equal(gate.ok, true);
    assert.equal(gate.granted, 2);
    assert.equal(gate.total, 2);
    assert.equal(gate.reason, null);
  });

  it("**有人还没表态 → 拦下**", () => {
    const gate = consentGate([entry("granted"), entry("pending")]);
    assert.equal(gate.ok, false);
    assert.equal(gate.outstanding, 1);
    assert.match(gate.reason ?? "", /还有 1 位原作者没有同意（1\/2）/);
  });

  it("**有人明确拒绝 → 同样拦下**", () => {
    /*
     * 这是最要紧的一条。只数 pending 的话，一个拒绝过的人会被当成
     * 「处理完了」，而他的发言照样被公开 ——
     * 「多数同意」在这里不成立：被拒绝的那个人的发言依然会被公开。
     */
    const gate = consentGate([entry("granted"), entry("denied")]);
    assert.equal(gate.ok, false, "有人拒绝了却放行了");
    assert.equal(gate.outstanding, 1);
  });

  it("**九个人同意、一个人拒绝，仍然拦下**", () => {
    const log = [...Array(9)].map(() => entry("granted"));
    log.push(entry("denied"));
    assert.equal(consentGate(log).ok, false, "多数同意就放行了 —— 这条约束不是投票");
  });

  it("全都没表态", () => {
    const gate = consentGate([entry("pending"), entry("pending")]);
    assert.equal(gate.ok, false);
    assert.equal(gate.granted, 0);
    assert.equal(gate.outstanding, 2);
  });

  it("**不是群聊转帖的（没有同意日志）不受这条管**", () => {
    /*
     * 一篇原生帖子根本不会有 post_sources 行。
     * 把「空」判成「没人同意 → 拦下」的话，
     * 所有普通帖子的可见性都再也改不动了。
     */
    assert.equal(consentGate(null).ok, true);
    assert.equal(consentGate(undefined).ok, true);
    assert.equal(consentGate([]).ok, true);
  });

  it("**放行时不给拦截文案** —— 免得界面上冒出一句没头没尾的话", () => {
    assert.equal(consentGate([entry("granted")]).reason, null);
  });

  it("拦下时的文案带得出「几个人里有几个同意了」", () => {
    const gate = consentGate([entry("granted"), entry("pending"), entry("denied")]);
    assert.match(gate.reason ?? "", /1\/3/);
  });
});

describe("**接线：raiseVisibility 真的调它**", () => {
  const convert = readCode("lib/forum/convert.ts");

  it("调用了 consentGate", () => {
    /*
     * 这一条是这整件事的关键。判定拆出去、却没人调用的话，
     * 就从「没测的收口」变成了「没测的收口 + 一个骗人的规则函数」——
     * 严格更糟。
     */
    assert.match(convert, /const gate = consentGate\(source\.consentLog/);
    assert.match(convert, /if \(!gate\.ok\) return fail\(gate\.reason!\)/);
  });

  it("**不再自己数一遍** —— 两处判定迟早分叉", () => {
    const fn = convert.slice(convert.indexOf("export async function raiseVisibility"));
    assert.equal(
      fn.includes('status !== "granted"'),
      false,
      "raiseVisibility 里又出现了自己数同意状态的代码",
    );
  });

  it("**判定排在真正改可见性之前**", () => {
    /*
     * 排在后面的话，拦是拦住了，可见性已经改完了 ——
     * 而这个操作不可撤销：内容已经公开出去了。
     */
    const fn = convert.slice(convert.indexOf("export async function raiseVisibility"));
    const gateAt = fn.indexOf("consentGate(");
    const writeAt = fn.indexOf("db.transaction(");
    assert.ok(gateAt > 0 && writeAt > 0);
    assert.ok(gateAt < writeAt, "同意判定跑在写库后面了");
  });
});
