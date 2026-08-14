import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { asciiName, checkDomainDns, type Resolver } from "@/lib/mail/dns-check";

/**
 * DNS 体检的判定。
 *
 * ═════════════════════════════════════════
 * 这里最要紧的一条：`null` ≠ `false`
 * ═════════════════════════════════════════
 *
 * 「没查成」和「没配」混在一起的话，一次 DoH 限流会让后台
 * 把一百行全标成红灯 —— 而人跑去 DNSPod 重加一遍，
 * 加完发现还是红的，然后就再也不相信那些灯了。
 */

const MX = "publicmx.agenticlab.sh";

/** 一个假解析器：按 (name, type) 给答案 */
function fake(table: Record<string, string[]>): Resolver {
  return async (name, type) => {
    const key = `${name}:${type}`;
    if (!(key in table)) return []; // 查成了，但没有记录
    return table[key].map((data) => ({ type: type === "MX" ? 15 : 16, data }));
  };
}

const dead: Resolver = async () => null; // 一次都没查成

describe("A 标签", () => {
  it("ASCII 域名原样", () => {
    assert.equal(asciiName("Rickroll.ICU"), "rickroll.icu");
  });

  it("中文域名转成 punycode —— DNS 上只认这个", () => {
    assert.equal(asciiName("华立.icu"), "xn--xkrw23g.icu");
  });
});

describe("三项判定", () => {
  const good = fake({
    "rickroll.icu:MX": ["5 publicmx.agenticlab.sh."],
    "rickroll.icu:TXT": ["v=spf1 -all"],
    "_dmarc.rickroll.icu:TXT": ["v=DMARC1; p=reject;"],
  });

  it("全配对了就三个都真", async () => {
    const v = await checkDomainDns("rickroll.icu", MX, [good]);
    assert.deepEqual([v.mxOk, v.spfOk, v.dmarcOk], [true, true, true]);
  });

  it("MX 末尾那个点不影响比对", async () => {
    // MX 记录的值带尾点，设置里的通常不带 —— 不归一化的话一百行全红
    const v = await checkDomainDns("rickroll.icu", "publicmx.agenticlab.sh.", [good]);
    assert.equal(v.mxOk, true);
  });

  it("MX 指到别处算没配对", async () => {
    const v = await checkDomainDns(
      "x.icu",
      MX,
      [fake({ "x.icu:MX": ["10 mx.qq.com."] })],
    );
    assert.equal(v.mxOk, false);
    assert.deepEqual(v.detail.mx, ["10 mx.qq.com."], "要把查到的原文带出来，否则没法排查");
  });

  it("SPF 和别的 TXT 混在一起也认得出来", async () => {
    const v = await checkDomainDns(
      "x.icu",
      MX,
      [fake({ "x.icu:TXT": ["google-site-verification=abc", "v=spf1 -all"] })],
    );
    assert.equal(v.spfOk, true);
  });

  it("中文域名按 punycode 去查", async () => {
    const v = await checkDomainDns(
      "华立.icu",
      MX,
      [fake({ "xn--xkrw23g.icu:MX": ["5 publicmx.agenticlab.sh."] })],
    );
    assert.equal(v.mxOk, true);
  });
});

describe("★ 「没查成」和「没配」必须分开", () => {
  it("一家都没查成 → null，不是 false", async () => {
    const v = await checkDomainDns("x.icu", MX, [dead]);
    assert.deepEqual([v.mxOk, v.spfOk, v.dmarcOk], [null, null, null]);
  });

  it("查成了但确实没记录 → false", async () => {
    const v = await checkDomainDns("x.icu", MX, [fake({})]);
    assert.deepEqual([v.mxOk, v.spfOk, v.dmarcOk], [false, false, false]);
  });
});

describe("★ 两家一起问，任一家查到就算有", () => {
  /*
   * 这不是冗余设计，是实测撞上的：记录刚加、TTL 又短的时候，
   * Google 说 bluecat.icu 没有 MX，而 Cloudflare 同一秒查得到。
   * 只问一家会报出一堆并不存在的「缺记录」。
   */
  const stale = fake({}); // 缓存还没同步：查成了，但没答案
  const fresh = fake({ "x.icu:MX": ["5 publicmx.agenticlab.sh."] });

  it("一家缓存旧、另一家有 → 算有", async () => {
    const v = await checkDomainDns("x.icu", MX, [stale, fresh]);
    assert.equal(v.mxOk, true);
  });

  it("顺序反过来也一样", async () => {
    const v = await checkDomainDns("x.icu", MX, [fresh, stale]);
    assert.equal(v.mxOk, true);
  });

  it("一家挂了、另一家有 → 算有，不算「没查成」", async () => {
    const v = await checkDomainDns("x.icu", MX, [dead, fresh]);
    assert.equal(v.mxOk, true);
  });

  it("两家都说没有 → 才算没配", async () => {
    const v = await checkDomainDns("x.icu", MX, [stale, fake({})]);
    assert.equal(v.mxOk, false);
  });
});
