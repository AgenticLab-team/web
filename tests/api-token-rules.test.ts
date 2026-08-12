import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DANGEROUS_SCOPES,
  MAX_MESSAGE_CHARS,
  SCOPE_KEYS,
  SEND_LIMIT,
  TOKEN_PREFIX,
  checkSendLimit,
  effectiveLimits,
  formatToken,
  looksLikeToken,
  normalizeScopes,
  tokenFromHeader,
  validateMessage,
  withAttribution,
  attributionCost,
} from "@/lib/api-tokens/rules";

/**
 * 开放 API 的令牌规则。
 *
 * ═════════════════════════════════════════
 * 这是全站唯一一处「拿到一串字符就能替人做事」的东西
 * ═════════════════════════════════════════
 *
 * 别的入口都要过登录会话 —— 会话有设备、有 IP、有过期、能一键下线。
 * 令牌没有这些：它就是一串字符，抄到哪里都能用。
 *
 * 而 `groups:send` 会往一千六百人的群里发东西，**署名还是机器人**——
 * 也就是说令牌泄漏的后果不由泄漏者承担，由这个社区承担。
 */

describe("令牌的形状", () => {
  const bytes = new Uint8Array(32).fill(7);

  it("带前缀", () => {
    /*
     * 有前缀才能在日志、issue、聊天记录里一眼认出这是一把钥匙。
     * 一串没有前缀的随机字符，粘在群里没有人会觉得需要撤销。
     */
    assert.ok(formatToken(bytes).plaintext.startsWith(TOKEN_PREFIX));
  });

  it("**用 base64url，不用 hex** —— 这串东西是要被复制粘贴的", () => {
    const { plaintext } = formatToken(bytes);
    const body = plaintext.slice(TOKEN_PREFIX.length);
    assert.equal(body.length, 43, "32 字节的 base64url 应该是 43 个字符");
    assert.equal(/^[A-Za-z0-9_-]+$/.test(body), true, "混进了 base64url 之外的字符");
  });

  it("**没有 `+` `/` `=`** —— 它们在 URL 和命令行里都要转义", () => {
    const { plaintext } = formatToken(new Uint8Array([251, 255, 254, 253]));
    assert.equal(/[+/=]/.test(plaintext), false);
  });

  it("列表上认人的那几位来自令牌本身", () => {
    const { plaintext, visible } = formatToken(bytes);
    assert.ok(plaintext.includes(visible));
    assert.equal(visible.length, 6);
  });

  it("不同的随机字节给出不同的令牌", () => {
    const a = formatToken(new Uint8Array(32).fill(1)).plaintext;
    const b = formatToken(new Uint8Array(32).fill(2)).plaintext;
    assert.notEqual(a, b);
  });
});

describe("**形状不对就不必查库**", () => {
  it("认得出自己发的", () => {
    assert.equal(looksLikeToken(formatToken(new Uint8Array(32).fill(3)).plaintext), true);
  });

  for (const [what, value] of [
    ["空", ""],
    ["没有前缀", "a".repeat(43)],
    /*
     * ↓ 这一条是突变测试逼出来的。
     *
     * 上面那条「没有前缀」其实**验不到前缀检查**：43 个字符切掉 3 位
     * 只剩 40 位，长度那一关先把它拦下了。所以要一个
     * **长度刚好对、只有前缀不对**的：拿掉前缀检查时只有它会红。
     */
    ["前缀不对但长度对", `zz_${"a".repeat(43)}`],
    ["长度不对", `${TOKEN_PREFIX}abc`],
    ["混了非法字符", `${TOKEN_PREFIX}${"a".repeat(42)}!`],
    ["不是字符串", 12345],
    ["null", null],
    ["前缀像但更长", `${TOKEN_PREFIX}${"a".repeat(44)}`],
  ] as const) {
    it(`${what} → 不认`, () => assert.equal(looksLikeToken(value), false));
  }
});

describe("**只从 Authorization 头取**", () => {
  it("Bearer 认得出", () => {
    assert.equal(tokenFromHeader("Bearer al_abc"), "al_abc");
  });

  it("大小写不敏感、多余空白不影响", () => {
    assert.equal(tokenFromHeader("  bearer   al_abc  "), "al_abc");
  });

  it("**别的方案不认**", () => {
    assert.equal(tokenFromHeader("Basic al_abc"), null);
    assert.equal(tokenFromHeader("al_abc"), null);
  });

  it("空头返回 null", () => {
    assert.equal(tokenFromHeader(null), null);
    assert.equal(tokenFromHeader(""), null);
  });
});

describe("scope", () => {
  it("认不出的丢掉，不报错", () => {
    /*
     * 报错会让整个请求失败；丢掉只是少一项权限 ——
     * 少给永远比多给安全。
     */
    assert.deepEqual(normalizeScopes(["me:read", "不存在的", 42]), ["me:read"]);
  });

  it("去重", () => {
    assert.deepEqual(normalizeScopes(["me:read", "me:read"]), ["me:read"]);
  });

  it("**顺序稳定** —— 列表和审计里读起来才不跳", () => {
    const a = normalizeScopes(["groups:send", "me:read"]);
    const b = normalizeScopes(["me:read", "groups:send"]);
    assert.deepEqual(a, b);
  });

  it("不是数组时给空", () => {
    for (const bad of [null, undefined, "me:read", {}]) {
      assert.deepEqual(normalizeScopes(bad), []);
    }
  });

  it("**`groups:send` 被标成危险级** —— 它往一千六百人的群里发东西", () => {
    assert.ok(DANGEROUS_SCOPES.includes("groups:send"));
  });

  it("读类的不算危险", () => {
    assert.equal(DANGEROUS_SCOPES.includes("me:read" as never), false);
    assert.equal(DANGEROUS_SCOPES.includes("groups:read" as never), false);
  });

  it("每个 scope 都说得出它到底给了什么", () => {
    for (const key of SCOPE_KEYS) {
      assert.ok(key.includes(":"), `${key} 命名不对`);
    }
  });
});

describe("**发消息限流：别把全站额度吃干**", () => {
  /*
   * 上游是 20 条/分钟、200 条/小时，而且**全站共用一把 key** ——
   * 所有成员的令牌、站长的群发、告警投递，抢的是同一个池子。
   *
   * 一个人写错一个循环就能把额度吃干，那时候站长发不出公告、
   * 告警也发不出来 —— 「出事了没人知道」和「出事」同时发生。
   */
  it("每把令牌的上限远低于全站额度", () => {
    assert.ok(SEND_LIMIT.perMinute < 20, "分钟上限没有给公告和告警留余量");
    assert.ok(SEND_LIMIT.perHour < 200, "小时上限没有给公告和告警留余量");
    // 留出的余量要够一次群发（十几个群）
    assert.ok(20 - SEND_LIMIT.perMinute >= 15, "分钟余量不够发一轮公告");
  });

  it("没超就放行", () => {
    assert.equal(checkSendLimit({ minute: 0, hour: 0, day: 0 }).allowed, true);
  });

  it("**三个窗口分别报** —— 只说「超限了」的话不知道该等多久", () => {
    const m = checkSendLimit({ minute: SEND_LIMIT.perMinute, hour: 0, day: 0 });
    assert.equal(m.allowed, false);
    assert.match(m.error!, /每分钟/);
    assert.equal(m.retryAfterSeconds, 60);

    const h = checkSendLimit({ minute: 0, hour: SEND_LIMIT.perHour, day: 0 });
    assert.match(h.error!, /每小时/);
    assert.ok(h.retryAfterSeconds! > 60);

    const d = checkSendLimit({ minute: 0, hour: 0, day: SEND_LIMIT.perDay });
    assert.match(d.error!, /每天/);
    assert.ok(d.retryAfterSeconds! > 600);
  });

  it("**先报最紧的那个** —— 三个一起超时该说分钟", () => {
    const got = checkSendLimit({
      minute: SEND_LIMIT.perMinute,
      hour: SEND_LIMIT.perHour,
      day: SEND_LIMIT.perDay,
    });
    assert.match(got.error!, /每分钟/);
  });

  it("刚好卡在上限就该拦 —— 用 >= 不是 >", () => {
    assert.equal(checkSendLimit({ minute: SEND_LIMIT.perMinute, hour: 0, day: 0 }).allowed, false);
    assert.equal(
      checkSendLimit({ minute: SEND_LIMIT.perMinute - 1, hour: 0, day: 0 }).allowed,
      true,
    );
  });
});

describe("要发的内容", () => {
  it("正常一句话通过，并且去掉首尾空白", () => {
    const got = validateMessage("  你好  ");
    assert.equal(got.ok, true);
    assert.equal(got.text, "你好");
  });

  it("**空的不行** —— 全是空白也算空", () => {
    assert.equal(validateMessage("").ok, false);
    assert.equal(validateMessage("   \n  ").ok, false);
  });

  it("不是字符串不行", () => {
    for (const bad of [null, 42, {}, ["hi"]]) {
      assert.equal(validateMessage(bad).ok, false);
    }
  });

  it("**太长的不行** —— 在群里就是刷屏", () => {
    // 预算要扣掉那行一定会加上去的代发署名
    const budget = MAX_MESSAGE_CHARS - attributionCost("小明");
    assert.equal(validateMessage("字".repeat(budget), "小明").ok, true);
    assert.equal(validateMessage("字".repeat(budget + 1), "小明").ok, false);
  });

  it("**长度按码点算** —— emoji 不能算两个字", () => {
    const budget = MAX_MESSAGE_CHARS - attributionCost("小明");
    assert.equal(validateMessage("🎉".repeat(budget), "小明").ok, true);
  });

  it("拒绝时不把原文带出来", () => {
    // 错误信息会进日志，而这段文字是用户内容
    const got = validateMessage("字".repeat(MAX_MESSAGE_CHARS + 1), "小明");
    assert.equal(got.text, "");
  });
});

describe("**代发署名：每一条都必须带**", () => {
  /*
   * 消息是机器人账号发出去的，群里看到的是机器人在说话 ——
   * 谁让它说的，群里的人一个字都看不到。
   *
   * 那意味着两件坏事：有人借机器人的嘴说话而责任落在站长身上；
   * 出事之后要靠翻我们自己的库才说得清是谁，
   * 而群里的当事人当时根本无从判断。
   */
  it("正文后面跟一行署名", () => {
    const got = withAttribution("大家好", "小明");
    assert.match(got, /^大家好\n/);
    assert.match(got, /本消息由「小明」使用 AgenticLab\.sh 代发/);
  });

  it("**名字空的时候也不能没有署名**", () => {
    // 宁可写「某位成员」，也不能出现一条没有出处的消息
    const got = withAttribution("在吗", "   ");
    assert.match(got, /本消息由「某位成员」/);
  });

  it("署名是最后一行 —— 不能夹在正文中间", () => {
    const lines = withAttribution("第一行\n第二行", "小明").split("\n");
    assert.equal(lines.at(-1)?.includes("代发"), true);
    assert.equal(lines.length, 3);
  });

  it("**正文长度上限要为署名让位**", () => {
    /*
     * 不预留的话，一条刚好压线的正文加上署名会在上游被拒，
     * 而错误信息是「上游拒绝」—— 没有人会想到是署名撑破的。
     */
    const name = "一个名字很长的成员";
    const cost = attributionCost(name);
    assert.ok(cost > 10, "署名成本算成 0 了");

    const justFits = "字".repeat(MAX_MESSAGE_CHARS - cost);
    assert.equal(validateMessage(justFits, name).ok, true);
    assert.equal(validateMessage(justFits + "字", name).ok, false);
  });

  it("**拼完整条也不超过总上限**", () => {
    const name = "小明";
    const body = "字".repeat(MAX_MESSAGE_CHARS - attributionCost(name));
    const full = withAttribution(validateMessage(body, name).text, name);
    assert.ok([...full].length <= MAX_MESSAGE_CHARS, `拼完是 ${[...full].length} 字`);
  });

  it("名字越长，正文能写的越少 —— 报错里要说得出剩多少", () => {
    const got = validateMessage("字".repeat(MAX_MESSAGE_CHARS), "特别特别长的一个名字");
    assert.equal(got.ok, false);
    assert.match(got.error!, /另有一行代发署名/);
  });
});

describe("**授权自己的额度：只能收紧，不能放宽**", () => {
  /*
   * 两份额度保的是两件不同的事：
   *   · 全局那份保**全站不被一个人吃干**（上游 20 条/分钟全站共用，
   *     还要给站长公告和系统告警留余量）
   *   · 授权那份保**单个群不被一个人刷屏**
   *
   * 允许放宽的话，在授权上填一个大数就能绕过那条底线 ——
   * 而那条底线失效的样子是「出事了没人知道」和「出事」同时发生。
   */
  it("不填就跟着全局走", () => {
    assert.deepEqual(effectiveLimits(null), { ...SEND_LIMIT });
    assert.deepEqual(effectiveLimits({}), { ...SEND_LIMIT });
  });

  it("填得更严就用更严的", () => {
    assert.equal(effectiveLimits({ perMinute: 1 }).perMinute, 1);
  });

  it("**填得更松也没用** —— 取两者更严的那个", () => {
    const got = effectiveLimits({ perMinute: 999, perHour: 999, perDay: 999 });
    assert.deepEqual(got, { ...SEND_LIMIT });
  });

  it("每一档各管各的 —— 只收紧分钟不影响小时", () => {
    const got = effectiveLimits({ perMinute: 1 });
    assert.equal(got.perMinute, 1);
    assert.equal(got.perHour, SEND_LIMIT.perHour);
  });

  it("**0 是合法的** —— 那是「暂时不许发但保留授权」", () => {
    assert.equal(effectiveLimits({ perMinute: 0 }).perMinute, 0);
    assert.equal(checkSendLimit({ minute: 0, hour: 0, day: 0 }, effectiveLimits({ perMinute: 0 })).allowed, false);
  });

  it("负数当没填 —— 不能靠填 -1 变成无限", () => {
    assert.equal(effectiveLimits({ perMinute: -5 }).perMinute, SEND_LIMIT.perMinute);
  });

  it("限流判定要真的用上这份额度", () => {
    const tight = effectiveLimits({ perMinute: 1 });
    assert.equal(checkSendLimit({ minute: 1, hour: 0, day: 0 }, tight).allowed, false);
    assert.equal(checkSendLimit({ minute: 0, hour: 0, day: 0 }, tight).allowed, true);
  });
});
