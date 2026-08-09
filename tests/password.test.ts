import assert from "node:assert/strict";
import { randomBytes, scryptSync } from "node:crypto";
import { describe, it } from "node:test";

import {
  GENERIC_LOGIN_ERROR,
  LOCKOUT_MS,
  LOCKOUT_THRESHOLD,
  MIN_LENGTH,
  checkLockout,
  checkPassword,
  hashPassword,
  needsRehash,
  verifyPassword,
} from "@/lib/auth/password";

/**
 * 密码兜底登录。
 *
 * 它是**兜底**不是第二条正门：这个站的身份锚点是微信群里那条验证码，
 * 密码只能由已经登录的人设置。它解决的是 Passkey 换设备就进不来、
 * 而那天群猫娘刚好被风控发不出验证码的情况。
 */

const NOW = 1_800_000_000_000;

describe("强度 —— 长度是唯一真正有用的维度", () => {
  it("太短不行", () => {
    const result = checkPassword("ab".repeat(4) + "c"); // 9 位
    assert.ok(MIN_LENGTH > 9);
    assert.equal(result.ok, false);
  });

  it("刚好到线就行", () => {
    assert.equal(checkPassword("correct-horse").ok, true);
  });

  it("**不要求大小写数字符号各一个**", () => {
    // 那套规则产出的是 Password1! 这种既难记又好猜的东西
    assert.equal(checkPassword("我今天想吃小笼包").ok, false, "中文八个字还不够长");
    assert.equal(checkPassword("我今天真的很想吃小笼包").ok, true, "够长的纯中文应该通过");
    assert.equal(checkPassword("aaaabbbbccccdddd").ok, true, "全小写够长也通过");
  });

  it("挡掉一定会被先试到的那几个", () => {
    for (const bad of ["password", "1234567890", "agenticlab", "qwertyuiop"]) {
      const result = checkPassword(bad);
      assert.equal(result.ok, false, bad);
    }
  });

  it("整串同一个字符不行", () => {
    assert.equal(checkPassword("bbbbbbbbbbbb").ok, false);
  });

  it("**首尾空格挡掉** —— 复制粘贴带进来，下次手打就对不上", () => {
    const result = checkPassword(" correct-horse ");
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && /手打会对不上/.test(result.error), true);
  });

  it("不能把昵称或微信 ID 放进去", () => {
    assert.equal(checkPassword("牛牛酱的密码超级长", { nickname: "牛牛酱" }).ok, false);
    assert.equal(checkPassword("wxid_abc123456789", { wxId: "wxid_abc" }).ok, false);
    assert.equal(checkPassword("完全无关的一串东西啊", { nickname: "牛牛酱" }).ok, true);
  });

  it("太短的昵称不参与判定 —— 一个叫「a」的人会没法设任何密码", () => {
    assert.equal(checkPassword("banana-republic", { nickname: "an" }).ok, true);
  });

  it("过长的挡掉", () => {
    assert.equal(checkPassword("x".repeat(200)).ok, false);
  });

  it("归一化之后再判长度 —— 全角字符不该算两个", () => {
    const result = checkPassword("ａｂｃｄｅｆｇｈｉｊ");
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.password, "abcdefghij");
  });
});

describe("哈希", () => {
  it("能存能验", () => {
    const stored = hashPassword("correct-horse-battery");
    assert.equal(verifyPassword("correct-horse-battery", stored), true);
    assert.equal(verifyPassword("correct-horse-batteryX", stored), false);
  });

  it("**每次哈希都不一样** —— 盐是随机的", () => {
    const a = hashPassword("correct-horse-battery");
    const b = hashPassword("correct-horse-battery");
    assert.notEqual(a, b);
    assert.equal(verifyPassword("correct-horse-battery", a), true);
    assert.equal(verifyPassword("correct-horse-battery", b), true);
  });

  it("**参数一起存下来** —— 将来调高强度时老密码还能验", () => {
    const stored = hashPassword("correct-horse-battery");
    const [algo, n, r, p] = stored.split("$");
    assert.equal(algo, "scrypt");
    assert.ok(Number(n) >= 16384);
    assert.ok(Number(r) >= 8);
    assert.ok(Number(p) >= 1);
  });

  it("能验用更低参数存下的老哈希，并标出要升级", () => {
    // 手工造一条低参数的（模拟历史遗留）
    const salt = randomBytes(16);
    const hash = scryptSync("old-password-here", salt, 64, { N: 16384, r: 8, p: 1 });
    const legacy = ["scrypt", 16384, 8, 1, salt.toString("base64url"), hash.toString("base64url")].join("$");

    assert.equal(verifyPassword("old-password-here", legacy), true, "老哈希验不了 = 把人锁在门外");
    assert.equal(needsRehash(legacy), true);
    assert.equal(needsRehash(hashPassword("x".repeat(12))), false);
  });

  it("坏掉的存储值一律验不过，而不是抛异常", () => {
    for (const junk of ["", "garbage", "scrypt$x$y$z", "bcrypt$1$2$3$4$5", "scrypt$0$0$0$a$b"]) {
      assert.equal(verifyPassword("anything", junk), false, junk);
    }
  });

  it("空密码验不过任何哈希", () => {
    assert.equal(verifyPassword("", hashPassword("correct-horse-battery")), false);
  });

  it("归一化一致 —— 设置时和登录时的全角半角要能对上", () => {
    const stored = hashPassword("ａｂｃｄｅｆｇｈｉｊ");
    assert.equal(verifyPassword("abcdefghij", stored), true);
  });
});

describe("锁定 —— IP 限流挡不住换 IP 爆破同一个人", () => {
  it("没到次数不锁", () => {
    const verdict = checkLockout({ failures: LOCKOUT_THRESHOLD - 1, lastFailureAt: NOW }, NOW);
    assert.equal(verdict.locked, false);
  });

  it("到次数就锁", () => {
    const verdict = checkLockout({ failures: LOCKOUT_THRESHOLD, lastFailureAt: NOW }, NOW);
    assert.equal(verdict.locked, true);
    assert.ok(verdict.retryAfterSeconds > 0);
  });

  it("**锁定是有时限的** —— 永久锁定等于谁都能把别人锁死", () => {
    const verdict = checkLockout(
      { failures: 99, lastFailureAt: NOW - LOCKOUT_MS },
      NOW,
    );
    assert.equal(verdict.locked, false);
  });

  it("倒计时随时间缩短", () => {
    const a = checkLockout({ failures: LOCKOUT_THRESHOLD, lastFailureAt: NOW }, NOW);
    const b = checkLockout({ failures: LOCKOUT_THRESHOLD, lastFailureAt: NOW }, NOW + 60_000);
    assert.ok(b.retryAfterSeconds < a.retryAfterSeconds);
  });

  it("**锁定时要给一条出路** —— 否则人只能干等", () => {
    const verdict = checkLockout({ failures: LOCKOUT_THRESHOLD, lastFailureAt: NOW }, NOW);
    assert.match(verdict.message, /群里的验证码/);
  });

  it("没有失败记录时不锁", () => {
    assert.equal(checkLockout({ failures: 0, lastFailureAt: null }, NOW).locked, false);
    assert.equal(checkLockout({ failures: 99, lastFailureAt: null }, NOW).locked, false);
  });
});

describe("对外的措辞", () => {
  it("**不区分「没有这个人」和「密码不对」**", () => {
    /*
     * 区分了就等于送了一个查询接口：输入一个微信号，
     * 从回答里就能知道他在不在这个社群 —— 而群成员名单是隐私。
     */
    assert.equal(GENERIC_LOGIN_ERROR.includes("不存在"), false);
    assert.equal(GENERIC_LOGIN_ERROR.includes("未注册"), false);
    assert.match(GENERIC_LOGIN_ERROR, /或/);
  });
});
