import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canForward,
  explainForwardRefusal,
  forwardEnvelope,
  FORWARD_MIN_LEVEL,
  FORWARD_PER_HOUR,
} from "@/lib/mail/forward-rules";

import { readCode } from "./_source";

/**
 * 转发 —— **最容易出的错是把自己变成开放中继**。
 *
 * ═════════════════════════════════════════
 * 那个错的下场是固定的
 * ═════════════════════════════════════════
 *
 * 「收到什么就往外发什么」本质上是让任何人都能通过我们的服务器
 * 给任何地址投递内容，而收件人看到的发件人是我们。
 * 几天之内被拿去发垃圾 → 域名进黑名单 →
 * **这个站所有的正常邮件都发不出去**。
 *
 * 下面每一条都在关同一扇门的不同缝。
 */

const ok = {
  level: 9,
  target: "me@gmail.com",
  targetVerified: true,
  ourDomains: ["good.icu", "temp.icu"],
  sentLastHour: 0,
};

describe("**四道闸**", () => {
  it("样样都够就转", () => {
    assert.equal(canForward(ok), null);
  });

  it("等级不够不转", () => {
    assert.equal(canForward({ ...ok, level: FORWARD_MIN_LEVEL - 1 })?.code, "level");
  });

  it("**没验证过的地址不转** —— 一个笔误就把私信寄给陌生人", () => {
    assert.equal(canForward({ ...ok, targetVerified: false })?.code, "unverified");
    assert.equal(canForward({ ...ok, target: null })?.code, "unverified");
  });

  it("**不转发到我们自己的域名** —— 那是无限循环", () => {
    /*
     * 这一条不能靠「用户不会那么干」：他可能把自己的一次性箱填进去
     * 当作「备份一份」，而那正好是最像合理用法的一种。
     */
    const r = canForward({ ...ok, target: "x@good.icu" });
    assert.equal(r?.code, "self_domain");
  });

  it("**大小写不影响那条判断**", () => {
    // `X@GOOD.ICU` 和 `x@good.icu` 是同一个域名，而循环不会因为大小写就停
    assert.equal(canForward({ ...ok, target: "X@GOOD.ICU" })?.code, "self_domain");
  });

  it("**有频率上限** —— 被拿去当靶子时，上限就是爆炸半径", () => {
    /*
     * 临时箱最常见的滥用就是被拿去做转发靶子：有人把一个能公开投递
     * 的地址挂出去，所有垃圾邮件经我们转到某个受害者信箱 ——
     * 而在收件人眼里，发信的是我们。
     */
    assert.equal(canForward({ ...ok, sentLastHour: FORWARD_PER_HOUR })?.code, "rate");
  });

  it("**先说他改变不了的** —— 等级排在验证和频率前面", () => {
    const r = canForward({
      ...ok,
      level: 1,
      targetVerified: false,
      sentLastHour: FORWARD_PER_HOUR,
    });
    assert.equal(r?.code, "level");
  });

  it("每一种拒绝都说得出下一步", () => {
    for (const r of [
      { code: "level", need: 5, have: 2 },
      { code: "unverified" },
      { code: "self_domain", domain: "good.icu" },
      { code: "rate", limit: 50 },
    ] as const) {
      assert.ok(explainForwardRefusal(r).length > 8, `${r.code} 的说法太短`);
    }
  });
});

describe("**转发出去那封信不冒充别人**", () => {
  const env = forwardEnvelope({
    originalFrom: "sender@example.com",
    originalFromName: "某服务",
    toAddress: "hello@good.icu",
    subject: "验证码",
    bodyText: "你的码是 123456",
    mailFrom: "noreply@agenticlab.sh",
  });

  it("**Reply-To 指向原始发件人** —— 这样「回复」还是回给对方", () => {
    assert.equal(env.replyTo, "sender@example.com");
  });

  it("正文顶上写清楚这是转发，以及原来是谁发的", () => {
    /*
     * 直接拿原始发件人当 From 发出去（伪造发件人）是最直觉的做法，
     * 而它会让每一封转发都通不过 SPF/DKIM —— 对方要么判垃圾要么拒收。
     * 更糟的是它让我们看起来在冒充别人。
     */
    assert.match(env.text, /转发/);
    assert.match(env.text, /sender@example\.com/);
    assert.match(env.text, /hello@good\.icu/);
  });

  it("原文还在", () => {
    assert.match(env.text, /123456/);
  });

  it("主题带前缀 —— 收件人一眼看得出这不是直接发给他的", () => {
    assert.match(env.subject, /转发/);
    assert.match(env.subject, /验证码/);
  });
});

describe("**它不能拖住收信**", () => {
  const ingest = readCode("lib/mail/ingest.ts");

  it("收信那条路上**没有 await 转发**", () => {
    /*
     * 收信是同步的：网关在等我们的响应，而它那头连着一个正在等 250
     * 的发信服务器。await 一次外部 HTTPS 接口的结果是发信方超时重投，
     * 而每一次重投我们都要再转一次。
     */
    assert.match(ingest, /forwardMessage\(/, "根本没接转发");
    assert.equal(/await forwardMessage/.test(ingest), false, "收信在等转发的结果");
  });

  it("**转发自己吞异常** —— 它跑在返回路径之外，抛出去没人接", () => {
    /*
     * 在 Node 里那是一个 unhandledRejection，而它会把整个进程带下去。
     * 一封转发失败不该让站挂掉。
     */
    const fwd = readCode("lib/mail/forward.ts");
    assert.match(fwd, /catch\s*\{/);
  });

  it("**事件里不记转发到哪个地址**", () => {
    /*
     * 事件表是后台看得到的，而「某某的私人邮箱是什么」
     * 不是管理员该顺便知道的东西。
     */
    const fwd = readCode("lib/mail/forward.ts");
    const detail = fwd.slice(fwd.indexOf('event: result.ok ? "forwarded"'));
    assert.equal(/user\.email/.test(detail.slice(0, 400)), false, "把私人邮箱记进事件表了");
  });
});

describe("**没配发信服务就明确失败，不静默丢**", () => {
  const sender = readCode("lib/mail/sender.ts");

  it("认不出的供应商名不猜一个默认值", () => {
    /*
     * 猜默认值的后果是：他把 `MAIL_SEND_PROVIDER` 拼错了，
     * 而系统安静地用了另一家的接口、拿着一把不匹配的 key，
     * 然后所有转发都失败，错误信息是「401」。
     */
    assert.match(sender, /不认识的发信服务/);
  });

  it("**分得清可重试和不可重试**", () => {
    /*
     * 把「地址不存在」当成可重试的话，我们会对着一个永远不存在的地址
     * 重试到天荒地老 —— 而每一次重试在对方眼里都是一次投递尝试，
     * 那正是垃圾发送者的形状。
     */
    assert.match(sender, /res\.status >= 500 \|\| res\.status === 429/);
  });

  it("有超时 —— 收信在等它", () => {
    assert.match(sender, /AbortSignal\.timeout/);
  });
});

describe("**开关别人的转发 —— 归属校验必须和写在同一条 where 里**", () => {
  const actions = readCode("lib/mail/forward-actions.ts");

  it("update 的 where 里同时有 id 和 userId", () => {
    /*
     * ═════════════════════════════════════════
     * 第一版是先写后查的，而那是最坏的组合
     * ═════════════════════════════════════════
     *
     * 写完再确认「是不是他的」，然后返回一句「没有这个地址」——
     * 而那时候开关**已经打开了**。一句拒绝的话配上一次成功的写入：
     * 攻击者看到的是失败，而效果达成了。
     *
     * 打开别人箱子的转发意味着**别人的信开始进你的邮箱**，
     * 所以这一处是这个文件里唯一真正危险的地方。
     */
    const fn = actions.slice(actions.indexOf("export async function setBoxForwarding"));
    const whereAt = fn.indexOf(".where(");
    assert.notEqual(whereAt, -1, "找不到那条 where");
    const where = fn.slice(whereAt, whereAt + 200);
    assert.match(where, /mailBoxes\.id/, "where 里没有 id");
    assert.match(where, /mailBoxes\.userId/, "where 里没有 userId —— 谁都能开别人的转发");
  });

  it("**靠 changes 判成败**，不是写完再查一遍", () => {
    const fn = actions.slice(actions.indexOf("export async function setBoxForwarding"));
    assert.match(fn, /changes === 0/);
    // 写之后不该再有一次「这箱子是谁的」的查询
    const afterWrite = fn.slice(fn.indexOf(".run()"));
    assert.equal(
      /select\(/.test(afterWrite),
      false,
      "写完又查了一遍 —— 那说明写的时候没带上归属条件",
    );
  });
});

describe("**邮箱验证：没有它，转发是个永远不会生效的开关**", () => {
  const verify = readCode("lib/mail/verify-email.ts");

  it("验证成功会写 email_verified_at —— 转发那道闸认的就是它", () => {
    assert.match(verify, /emailVerifiedAt: Date\.now\(\)/);
  });

  it("**改地址会清掉旧的验证状态** —— 否则改地址就是绕过验证的方法", () => {
    assert.match(verify, /email,\s*emailVerifiedAt: null/);
  });

  it("**码存哈希不存明文**", () => {
    // 库被看到的时候它不该是一把能直接用的钥匙
    assert.match(verify, /createHash\("sha256"\)/);
    assert.equal(/secret: `\$\{code\}/.test(verify), false, "把明文码存进库了");
  });

  it("**比对用 timingSafeEqual** —— 六位数字本来就只有一百万种", () => {
    /*
     * 字符串比较会在第一个不同的字节上返回，而那个时间差
     * 足以让人逐字节猜出验证码。别再送他一个旁路。
     */
    assert.match(verify, /timingSafeEqual/);
  });

  it("用过就删，过期也删 —— 一个码只有一次机会", () => {
    const uses = [...verify.matchAll(/db\.delete\(credentials\)/g)];
    assert.ok(uses.length >= 2, `只删了 ${uses.length} 处，过期那条和用过那条都要删`);
  });

  it("**发不出去就别让他填** —— 一个填完永远收不到码的表单最让人上火", () => {
    assert.match(verify, /senderConfigured\(\)/);
  });
});
