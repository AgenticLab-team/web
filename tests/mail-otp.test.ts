import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractOtp } from "@/lib/mail/otp";

/**
 * 验证码抽取。
 *
 * 这一组测试的取向和别处不同：**大部分断言在证明它「不抽」**。
 * 抽不出来用户点开邮件看一眼就完了；抽错了他会复制、粘贴、
 * 提交、被拒，然后怀疑是网站的问题再试一次 —— 而很多网站三次就锁。
 */

describe("能抽到的", () => {
  it("主题里的 6 位数字", () => {
    const r = extractOtp({ subject: "Your verification code is 824193" });
    assert.equal(r.code, "824193");
  });

  it("中文验证码", () => {
    const r = extractOtp({ subject: "【某网站】验证码", bodyText: "您的验证码是 5821，5 分钟内有效" });
    assert.equal(r.code, "5821");
  });

  it("大写字母数字混合（GitHub / Steam 那一类）", () => {
    const r = extractOtp({ subject: "Your one-time passcode", bodyText: "Code: A4K9QZ" });
    assert.equal(r.code, "A4K9QZ");
  });

  it("分段码", () => {
    const r = extractOtp({ subject: "Your verification code", bodyText: "code is 123-456" });
    assert.equal(r.code, "123-456");
  });

  it("主题优先于正文 —— 主题的噪声小得多", () => {
    const r = extractOtp({
      subject: "Verification code 111222",
      bodyText: "订单号 998877，验证码 111222",
    });
    assert.equal(r.code, "111222");
  });
});

describe("坚决不抽的", () => {
  it("★ 没有验证码语境词就不猜", () => {
    // 一封普通的订单邮件里的 6 位数字，是订单号不是验证码
    const r = extractOtp({ subject: "订单已发货", bodyText: "运单号 887766" });
    assert.equal(r.code, null);
    assert.match(r.reason, /语境词/);
  });

  it("★ 多个不同候选时不抽 —— 挑错一个的代价是账号被锁", () => {
    const r = extractOtp({
      bodyText: "您的验证码是 123456，订单号 998877，请勿泄露",
    });
    assert.equal(r.code, null);
    assert.match(r.reason, /候选/);
  });

  it("同一个码出现多次算一个，照常抽", () => {
    const r = extractOtp({
      bodyText: "验证码：246810。再说一遍，验证码是 246810。",
    });
    assert.equal(r.code, "246810");
  });

  it("★ 页脚的年份不算 —— 几乎每封信都有一个 © 2026", () => {
    const r = extractOtp({ subject: "Your verification code", bodyText: "© 2026 Example Inc." });
    assert.equal(r.code, null);
  });

  it("全是同一个数字的占位符不算", () => {
    const r = extractOtp({ subject: "verification code", bodyText: "0000" });
    assert.equal(r.code, null);
  });

  it("URL 里的数字不算", () => {
    const r = extractOtp({
      subject: "Confirm your email",
      bodyText: "点这里 https://example.com/confirm/998877 完成确认",
    });
    assert.equal(r.code, null);
  });

  it("金额不算", () => {
    const r = extractOtp({ subject: "verification code", bodyText: "已扣款 ¥123456" });
    assert.equal(r.code, null);
  });

  it("日期和时间不算", () => {
    const r = extractOtp({
      subject: "Your login code",
      bodyText: "登录时间 2026-08-13 17:45:22",
    });
    assert.equal(r.code, null);
  });

  it("纯字母的不算 —— 那更可能是个单词", () => {
    const r = extractOtp({ subject: "your verification code", bodyText: "PLEASE CONFIRM" });
    assert.equal(r.code, null);
  });

  it("空邮件不炸", () => {
    assert.equal(extractOtp({}).code, null);
    assert.equal(extractOtp({ subject: null, bodyText: null }).code, null);
  });
});

describe("正则状态不串", () => {
  it("连着抽两封，第二封不受第一封的 lastIndex 影响", () => {
    // 带 g 的正则复用同一个对象会带着 lastIndex 走，第二次从中间开始找
    const mail = { subject: "Your verification code is 445566" };
    assert.equal(extractOtp(mail).code, "445566");
    assert.equal(extractOtp(mail).code, "445566");
  });
});
