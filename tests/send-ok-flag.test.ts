import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sendFailed } from "@/lib/nekobot/types";
import { readCode } from "./_source";

/**
 * 「发消息 API 我感觉有 bug」—— 站长报的。
 *
 * ═════════════════════════════════════════
 * 发失败了，但记成了「已发送」
 * ═════════════════════════════════════════
 *
 * `request()` **只在 HTTP 非 2xx 时抛错**。而上游 `/send/text`
 * 发送失败时回的是 `200 {"ok": false}` —— 于是那一条在我们这边被记成
 * 「已发送」：计数说成功、界面说送达，而群里什么都没出现。
 *
 * 这个坑这个仓库踩过一次了：GitHub 换 token 那个接口也是
 * 「出错时也返回 200，错误信息在 body 的 error 字段」，
 * 注释就写在 `lib/github/api.ts` 上。**同一类错，第二个上游。**
 *
 * ═════════════════════════════════════════
 * 判定要偏保守
 * ═════════════════════════════════════════
 *
 * 只有 `ok === false` 算失败。缺字段时**当成功** ——
 * 把 `undefined` 当失败会让正常发送变成「失败」并触发重发，
 * 而重发的代价是同一条消息在一千六百人的群里出现两次。
 * 宁可漏判一次失败，不能误判一次成功。
 */

describe("**只有 `ok === false` 算失败**", () => {
  it("明确的 false → 失败", () => {
    assert.ok(sendFailed({ ok: false }));
  });

  it("true → 成功", () => {
    assert.equal(sendFailed({ ok: true }), null);
  });

  it("**缺字段 → 当成功** —— 误判成失败会导致重发", () => {
    /*
     * 群发那一侧靠这个判定决定要不要重试。判错方向的话，
     * 一千六百人会收到同一条消息两次 —— 那是不可逆的。
     */
    assert.equal(sendFailed({}), null);
    assert.equal(sendFailed({ msg_svr_id: "123" }), null);
  });

  it("**别的假值不算失败** —— 只认布尔 false", () => {
    // 上游哪天回 `ok: 0` 或 `ok: ""`，那是它的协议变了，该被人看见而不是被我们猜
    for (const v of [0, "", null, undefined]) {
      assert.equal(sendFailed({ ok: v as never }), null, `ok=${JSON.stringify(v)} 被当成了失败`);
    }
  });
});

describe("失败时说得出为什么", () => {
  it("带 error 字段就用它", () => {
    assert.match(sendFailed({ ok: false, error: "群已解散" })!, /群已解散/);
  });

  it("带 message 也认", () => {
    assert.match(sendFailed({ ok: false, message: "限流" })!, /限流/);
  });

  it("**什么都没带时把整个响应贴出来** —— 总比一句「失败了」强", () => {
    const got = sendFailed({ ok: false, weird_code: 42 })!;
    assert.match(got, /weird_code/);
  });

  it("再长也要截断 —— 这句话会进数据库和界面", () => {
    const huge = sendFailed({ ok: false, error: "x".repeat(5000) })!;
    assert.ok(huge.length < 400, `太长了：${huge.length}`);
  });
});

describe("**两个发送点都要看这个标志**", () => {
  it("群发：不看的话失败会被记成「已发送」", () => {
    const src = readCode("lib/broadcast/sender.ts");
    assert.match(src, /sendFailed\(result\)/);
    // 必须在写「已发送」之前就抛出去
    assert.ok(
      src.indexOf("sendFailed(result)") < src.indexOf('status: "sent"'),
      "检查跑在标记「已发送」之后了",
    );
  });

  it("告警：告警是那种没送到也没人会发现的东西", () => {
    /*
     * 它平时本来就不该响 —— 所以「发出去了」这句话一旦是假的，
     * 要等到真出事那天才会有人知道。
     */
    assert.match(readCode("lib/alerts/dispatch.ts"), /sendFailed\(await nekobot\.sendText/);
  });

  it("**判定收在一处** —— 两边各写一份 `ok !== false` 迟早分叉", () => {
    for (const f of ["lib/broadcast/sender.ts", "lib/alerts/dispatch.ts"]) {
      assert.equal(
        /ok\s*!==\s*false|ok\s*===\s*false/.test(readCode(f)),
        false,
        `${f} 自己又判了一遍`,
      );
    }
  });
});
