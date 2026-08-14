import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BURNER_CUSTOM_MIN_LENGTH,
  CLAIM_MIN_LENGTH,
  MAX_LOCAL_LENGTH,
  SYSTEM_RESERVED,
  addressFits,
  buildAddress,
  checkLocalPart,
  matchBanword,
  normalizeLocalPart,
  randomLocalPart,
  splitAddress,
} from "@/lib/mail/address-rules";

describe("前缀归一化", () => {
  it("去首尾空白、转小写", () => {
    assert.equal(normalizeLocalPart("  HeLLo  "), "hello");
  });

  it("**不动中间的空格** —— 那是替用户改他要的东西", () => {
    // 猜成 hello-world 的话，他会拿着一个自己没要过的地址去注册
    assert.equal(normalizeLocalPart("hello world"), "hello world");
  });
});

describe("前缀校验", () => {
  const claim = { purpose: "claim" as const };
  const burner = { purpose: "burner" as const };

  it("正常前缀通过", () => {
    assert.equal(checkLocalPart("hello", claim).ok, true);
    assert.equal(checkLocalPart("my.mail-01_x", claim).ok, true);
  });

  it("申领的下限比一次性箱低得多 —— 短前缀是最稀缺的资源", () => {
    assert.equal(CLAIM_MIN_LENGTH < BURNER_CUSTOM_MIN_LENGTH, true);
    assert.equal(checkLocalPart("hey", claim).ok, true);
    assert.equal(checkLocalPart("hey", burner).ok, false);
  });

  it("一次性箱的自选前缀卡在最短长度上 —— 防的是用它反复占好地址", () => {
    const short = "a".repeat(BURNER_CUSTOM_MIN_LENGTH - 1);
    const ok = "a".repeat(BURNER_CUSTOM_MIN_LENGTH);
    assert.equal(checkLocalPart(short, burner).ok, false);
    assert.equal(checkLocalPart(ok, burner).ok, true);
  });

  it("空格单独报错，不混进「格式不对」", () => {
    const r = checkLocalPart("hello world", claim);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /空格/);
  });

  it("首尾不能是分隔符，中间不能连着两个", () => {
    assert.equal(checkLocalPart("-hello", claim).ok, false);
    assert.equal(checkLocalPart("hello-", claim).ok, false);
    assert.equal(checkLocalPart("hel--lo", claim).ok, false);
    assert.equal(checkLocalPart("hel..lo", claim).ok, false);
  });

  it("超长挡下 —— 超出的部分不是我们说了算", () => {
    assert.equal(checkLocalPart("a".repeat(MAX_LOCAL_LENGTH), claim).ok, true);
    assert.equal(checkLocalPart("a".repeat(MAX_LOCAL_LENGTH + 1), claim).ok, false);
  });

  it("★ postmaster 和 abuse 永远不给 —— 投诉走这两个地址", () => {
    for (const word of SYSTEM_RESERVED) {
      // 连站长把 minLength 调成 0 都不该放行：这是代码里的一句话，不是配置
      const r = checkLocalPart(word, { purpose: "claim", minLength: 0 });
      assert.equal(r.ok, false, `${word} 不该放行`);
    }
  });

  it("大写会被归一化后通过，不是报错", () => {
    const r = checkLocalPart("HELLO", claim);
    assert.equal(r.ok, true);
    assert.equal(r.local, "hello");
  });
});

describe("禁用词", () => {
  const rules = [
    { word: "admin", kind: "exact" as const, reason: "会让收信人误判身份" },
    { word: "noreply", kind: "prefix" as const },
    { word: "paypal", kind: "contains" as const },
    { word: "^cs\\d+$", kind: "regex" as const },
    { word: "disabled", kind: "exact" as const, enabled: false },
  ];

  it("四种匹配都生效", () => {
    assert.ok(matchBanword("admin", rules));
    assert.ok(matchBanword("noreply-2026", rules));
    assert.ok(matchBanword("my-paypal-acct", rules));
    assert.ok(matchBanword("cs12345", rules));
  });

  it("关掉的规则不生效", () => {
    assert.equal(matchBanword("disabled", rules), null);
  });

  it("**写坏的正则不许把整条路堵死**", () => {
    const broken = [{ word: "([unclosed", kind: "regex" as const }];
    // 一条写坏的规则让所有人开不了箱，比漏掉一个词糟得多
    assert.doesNotThrow(() => matchBanword("anything", broken));
    assert.equal(matchBanword("anything", broken), null);
  });

  it("命中时把理由带出来 —— 用户要知道为什么被拒", () => {
    const r = checkLocalPart("admin", { purpose: "claim", banwords: rules });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /误判身份/);
  });
});

describe("地址拼接与拆分", () => {
  it("**用 punycode 那一半拼** —— 中文域名不转就收不到信", () => {
    assert.equal(buildAddress("hi", "xn--xkrw23g.icu"), "hi@xn--xkrw23g.icu");
  });

  it("按最后一个 @ 拆，不是第一个", () => {
    // 我们自己不发这种地址，但别人可以往我们这里发
    const r = splitAddress('"a@b"@example.com');
    assert.deepEqual(r, { local: '"a@b"', domain: "example.com" });
  });

  it("拆不动的返回 null，不抛", () => {
    assert.equal(splitAddress("no-at-sign"), null);
    assert.equal(splitAddress("@leading"), null);
    assert.equal(splitAddress("trailing@"), null);
  });

  it("地址总长卡在 254", () => {
    assert.equal(addressFits("a".repeat(60), "example.icu"), true);
    assert.equal(addressFits("a".repeat(64), "a".repeat(200) + ".icu"), false);
  });

  it("最长的那个域名加上前缀仍然塞得下", () => {
    // pneumonoultramicroscopicsilicovolcanoconiosis.icu，49 字符
    const longest = "pneumonoultramicroscopicsilicovolcanoconiosis.icu";
    assert.equal(addressFits("a".repeat(64), longest), true);
  });
});

describe("随机前缀", () => {
  const fixed = (n: number) => new Uint8Array(n).fill(7);

  it("长度可控、字符集固定", () => {
    const s = randomLocalPart(fixed, 12);
    assert.equal(s.length, 12);
    assert.match(s, /^[a-z0-9]+$/);
  });

  it("★ 不含形近字 —— 这串东西是要被人从屏幕抄下来的", () => {
    const all = new Uint8Array(256).map((_, i) => i);
    const s = randomLocalPart((n) => all.slice(0, n), 200);
    for (const bad of ["0", "o", "1", "l", "i"]) {
      assert.equal(s.includes(bad), false, `不该出现 ${bad}`);
    }
  });

  it("随机出来的前缀自己就过得了一次性箱的长度线", () => {
    const s = randomLocalPart(fixed);
    assert.equal(checkLocalPart(s, { purpose: "burner" }).ok, true);
  });
});
