import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { humanize, registerSuccessFeedback, revokeFeedback } from "@/components/passkey/feedback";

/**
 * Passkey 流程的用户可见反馈。
 *
 * 这些文案是用户判断「刚才到底成没成功」的唯一依据。
 * 曾经的问题：移除凭证的请求失败时界面毫无反应 ——
 * 用户以为钥匙删掉了，实际上它还能登录，这比报错更危险。
 */

describe("WebAuthn 错误翻译", () => {
  const err = (name: string, message = "raw browser message") => {
    const e = new Error(message);
    e.name = name;
    return e;
  };

  it("用户取消 / 超时说人话", () => {
    assert.equal(humanize(err("NotAllowedError")), "已取消，或者等待超时了");
  });

  it("重复注册给出明确指引", () => {
    assert.equal(humanize(err("InvalidStateError")), "这台设备已经注册过 Passkey 了");
  });

  it("**rpID 配置错误要能被区分出来** —— 这是配置问题不是用户问题", () => {
    assert.match(humanize(err("SecurityError")), /正式域名/);
  });

  it("网络失败不透传英文原文", () => {
    // fetch 网络断开抛的是 TypeError: Failed to fetch，用户看不懂
    assert.equal(humanize(err("TypeError", "Failed to fetch")), "网络异常，请检查连接后重试");
  });

  it("服务端返回的中文原因原样透出", () => {
    assert.equal(humanize(new Error("挑战值已失效，请重试")), "挑战值已失效，请重试");
  });

  it("非 Error 输入不抛错", () => {
    assert.equal(humanize("whatever"), "操作失败，请重试");
    assert.equal(humanize(undefined), "操作失败，请重试");
  });
});

describe("添加与移除的反馈", () => {
  it("添加成功给成功态提示", () => {
    assert.deepEqual(registerSuccessFeedback(), { kind: "success", message: "Passkey 已添加" });
    assert.deepEqual(registerSuccessFeedback("iPhone"), {
      kind: "success",
      message: "已添加「iPhone」",
    });
  });

  it("移除成功带上设备名 —— 多设备用户要知道删的是哪把", () => {
    assert.deepEqual(revokeFeedback("旧手机", { ok: true }), {
      kind: "success",
      message: "已移除「旧手机」",
    });
  });

  it("**移除失败必须报错并给出原因**，不能静默", () => {
    assert.deepEqual(revokeFeedback("旧手机", { ok: false, serverError: "找不到这个凭证" }), {
      kind: "error",
      message: "找不到这个凭证",
    });
  });

  it("服务端没给原因时也要有兜底文案", () => {
    assert.deepEqual(revokeFeedback("旧手机", { ok: false }), {
      kind: "error",
      message: "移除失败，请重试",
    });
  });
});
