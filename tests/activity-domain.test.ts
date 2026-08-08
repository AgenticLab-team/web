import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MIN_DOMAIN_LENGTH,
  checkDomainAvailability,
  checkDomainName,
  domainModule,
  normalizeDomainName,
} from "@/lib/activities/modules/domain";

/**
 * 域名发放模块。
 *
 * 本期只做登记：够格的人登记一个域名，系统查是否已被注册，
 * 未注册则进等待列表，管理员后续统一注册再回填结果。
 */

const TLDS = ["sh", "dev"];

describe("域名归一化", () => {
  it("大小写与空格都归一", () => {
    assert.equal(normalizeDomainName("  Agentic-LAB  "), "agentic-lab");
  });

  it("**用户把后缀一起填进来时会被去掉**", () => {
    // 输入框旁边已经有后缀选择器了，但总有人会连着填
    assert.equal(normalizeDomainName("agentic-lab.sh"), "agentic-lab");
    assert.equal(normalizeDomainName("foo.co.uk"), "foo");
  });
});

describe("域名校验", () => {
  it("正常域名通过", () => {
    const r = checkDomainName("agentic-lab", TLDS, "sh");
    assert.equal(r.ok, true);
    assert.equal(r.normalized, "agentic-lab.sh");
  });

  it("**短于下限的被拒** —— 短域名值钱，不在免费放出的范围里", () => {
    const r = checkDomainName("abcd", TLDS, "sh");
    assert.equal(r.ok, false);
    assert.match(r.error!, new RegExp(String(MIN_DOMAIN_LENGTH)));
  });

  it("刚好等于下限可以", () => {
    assert.equal(checkDomainName("abcde", TLDS, "sh").ok, true);
  });

  it("大写会被归一化后接受，不是报错", () => {
    assert.equal(checkDomainName("AgenticLab", TLDS, "sh").ok, true);
  });

  it("非法字符被拒", () => {
    assert.equal(checkDomainName("你好世界", TLDS, "sh").ok, false);
    assert.equal(checkDomainName("under_score", TLDS, "sh").ok, false);
  });

  it("**中间有空格时报错，而不是悄悄删掉**", () => {
    // 把「hello world」变成「helloworld」是替用户改了他要的东西 ——
    // 他想要的多半是「hello-world」，而域名一旦注册就是永久的
    assert.equal(checkDomainName("hello world", TLDS, "sh").ok, false);
  });

  it("首尾空白只是手滑，去掉不算改意图", () => {
    assert.equal(checkDomainName("  agentic-lab  ", TLDS, "sh").ok, true);
  });

  it("不能以连字符开头或结尾", () => {
    assert.equal(checkDomainName("-hello", TLDS, "sh").ok, false);
    assert.equal(checkDomainName("hello-", TLDS, "sh").ok, false);
  });

  it("**第 3、4 位不能同时是连字符** —— 那是国际化域名的保留前缀", () => {
    const r = checkDomainName("xn--abcdef", TLDS, "sh");
    assert.equal(r.ok, false);
    assert.match(r.error!, /保留前缀/);
  });

  it("超长的被拒", () => {
    assert.equal(checkDomainName("a".repeat(64), TLDS, "sh").ok, false);
  });

  it("不在允许列表里的后缀被拒", () => {
    const r = checkDomainName("agentic", TLDS, "com");
    assert.equal(r.ok, false);
    assert.match(r.error!, /sh/);
  });
});

describe("模块接口", () => {
  const config = { tlds: TLDS };

  it("校验通过时给出唯一性判据", () => {
    const r = domainModule.validate({ name: "agentic-lab", tld: "sh" }, config);
    assert.equal(r.ok, true);
    assert.equal(r.normalizedKey, "agentic-lab.sh");
  });

  it("**备用域名也要一起校验**", () => {
    // 等到首选被占才发现备用名不合法就太晚了
    const r = domainModule.validate(
      { name: "agentic-lab", tld: "sh", alternate: "ab" },
      config,
    );
    assert.equal(r.ok, false);
    assert.match(r.error!, /备用域名/);
  });

  it("没填备用名时不报错", () => {
    assert.equal(
      domainModule.validate({ name: "agentic-lab", tld: "sh", alternate: "  " }, config).ok,
      true,
    );
  });

  it("摘要给管理员看得懂的一行", () => {
    assert.equal(domainModule.describe({ name: "Agentic-Lab", tld: "sh" }), "agentic-lab.sh");
    assert.match(
      domainModule.describe({ name: "a-lab", tld: "sh", alternate: "b-lab" }),
      /备用 b-lab\.sh/,
    );
  });

  it("表单字段齐全且必填项标出来了", () => {
    assert.ok(domainModule.fields.length >= 2);
    assert.ok(domainModule.fields.some((f) => f.name === "name" && f.required));
  });
});

describe("可用性查询", () => {
  const fakeFetch = (status: number) =>
    (async () => new Response(status === 404 ? "" : "{}", { status })) as unknown as typeof fetch;

  it("**RDAP 404 表示可以注册**", () => {
    return checkDomainAvailability("agentic-lab.sh", { fetchImpl: fakeFetch(404) }).then((r) => {
      assert.equal(r.available, true);
    });
  });

  it("200 表示已被注册", async () => {
    const r = await checkDomainAvailability("google.com", { fetchImpl: fakeFetch(200) });
    assert.equal(r.available, false);
  });

  it("**查不到时返回「不知道」而不是「可用」**", async () => {
    // 判成可用的话，用户会以为登记成功，而管理员真去注册时才发现被占了 ——
    // 那时失望的代价比多等一会儿大得多
    const r = await checkDomainAvailability("x.sh", { fetchImpl: fakeFetch(500) });
    assert.equal(r.available, "unknown");
    assert.match(r.detail, /人工确认/);
  });

  it("**网络失败时也是「不知道」，不是「可用」**", async () => {
    const failing = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;

    const r = await checkDomainAvailability("x.sh", { fetchImpl: failing });
    assert.equal(r.available, "unknown");
    assert.match(r.detail, /ECONNRESET/);
  });

  it("超时不会一直挂着", async () => {
    const hanging = ((_: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;

    const r = await checkDomainAvailability("x.sh", { fetchImpl: hanging, timeoutMs: 20 });
    assert.equal(r.available, "unknown");
  });
});
