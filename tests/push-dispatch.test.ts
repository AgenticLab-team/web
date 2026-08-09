import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * 推送投递的接线测试。三件事必须被锁住：
 *
 * 1. **偏好真的被读到** —— 关掉某类推送的用户一条都不能收到。
 *    这个项目出过「表写了没人读」的坑，这里用注入的 getPrefs 证明
 *    投递路径确实过了偏好这一关。
 * 2. 冷却与合并 —— 第一条立即发，洪水攒成一条，且**不丢**。
 * 3. 没配置时是安静的空操作，不抛错也不假装发了。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-pushd-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

let dispatch: typeof import("@/lib/notifications/push-dispatch");
let prefsMod: typeof import("@/lib/notifications/prefs");
let wp: typeof import("@/lib/notifications/webpush");

before(async () => {
  dispatch = await import("@/lib/notifications/push-dispatch");
  prefsMod = await import("@/lib/notifications/prefs");
  wp = await import("@/lib/notifications/webpush");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

function fakeConfig() {
  const keys = wp.generateVapidKeys();
  return {
    publicKey: wp.b64uDecode(keys.publicKey),
    privateKey: wp.b64uDecode(keys.privateKey),
    subject: "mailto:t@example.com",
  };
}

interface Sent {
  endpoint: string;
  payload: { title: string; body: string; link: string; count: number };
}

function harness(opts: {
  prefs?: (userId: string) => ReturnType<typeof prefsMod.defaultPrefs>;
  subs?: (userId: string) => { id: string; endpoint: string; p256dh: string; auth: string }[];
  configured?: boolean;
}) {
  const sent: Sent[] = [];
  const results: { subId: string; gone: boolean }[] = [];
  let now = 1_000_000;
  const d = dispatch.createPushDispatcher({
    getConfig: () => (opts.configured === false ? null : fakeConfig()),
    getPrefs: opts.prefs ?? (() => prefsMod.defaultPrefs()),
    listSubs:
      opts.subs ??
      ((userId) => [{ id: `sub-${userId}`, endpoint: `https://push.example/${userId}`, p256dh: "", auth: "" }]),
    send: async (target, payload) => {
      sent.push({ endpoint: target.endpoint, payload: payload as Sent["payload"] });
      return { ok: true, gone: false };
    },
    onResult: (subId, result) => results.push({ subId, gone: result.gone }),
    now: () => now,
  });
  return {
    d,
    sent,
    results,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const row = (userId: string, type: string, title: string) => ({
  userId,
  type,
  title,
  body: null,
  link: "/forum/p/x",
});

async function settle() {
  // send 是 fire-and-forget 的 promise，让微任务队列跑完再断言
  await new Promise((resolve) => setImmediate(resolve));
}

describe("偏好接线", () => {
  it("关掉推送的类型一条都不发 —— 偏好必须真的被读到", async () => {
    const prefs = prefsMod.defaultPrefs();
    prefs.mention = { ...prefs.mention, push: false };
    const h = harness({ prefs: () => prefs });

    h.d.offer([row("u1", "mention", "有人@你")]);
    await settle();
    assert.equal(h.sent.length, 0);

    h.d.offer([row("u1", "reply_to_post", "有人回复你")]);
    await settle();
    assert.equal(h.sent.length, 1);
  });

  it("reaction 的推送默认就是关的 —— 量最大的一类不该默认打到锁屏", async () => {
    const h = harness({});
    h.d.offer([row("u1", "reaction", "有人点了表情")]);
    await settle();
    assert.equal(h.sent.length, 0);
  });

  it("站内关掉（site=false）的类型根本不会产生通知行，推送无从谈起", () => {
    // 这条锁在 notify() 的入口（tests/notify.test.ts 里有），这里只锁语义：
    // push 通道的判断独立于 site —— site 开 push 关是合法组合
    const prefs = prefsMod.defaultPrefs();
    prefs.mention = { ...prefs.mention, site: true, push: false };
    assert.equal(prefsMod.isEnabled(prefs, "mention", "site"), true);
    assert.equal(prefsMod.isEnabled(prefs, "mention", "push"), false);
  });
});

describe("冷却与合并", () => {
  it("第一条立即发 —— 「即时」的意义所在", async () => {
    const h = harness({});
    h.d.offer([row("u1", "mention", "第一条")]);
    await settle();
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].payload.title, "第一条");
    assert.equal(h.sent[0].payload.count, 1);
  });

  it("冷却期内攒着不丢，到点合并成一条", async () => {
    const h = harness({});
    h.d.offer([row("u1", "mention", "第一条")]);
    await settle();

    // 冷却期内的三条：不发，也不丢
    h.d.offer([row("u1", "reply_to_post", "第二条")]);
    h.d.offer([row("u1", "reply_to_post", "第三条")]);
    h.d.offer([row("u1", "mention", "第四条")]);
    await settle();
    assert.equal(h.sent.length, 1, "冷却期内不该发");

    h.advance(dispatch.PUSH_COOLDOWN_MS + 1);
    h.d.flushDue();
    await settle();
    assert.equal(h.sent.length, 2);
    // 合并后的那条以最新一条为题，其余折叠成条数 —— 丢掉的话用户下次就不信推送了
    assert.equal(h.sent[1].payload.title, "第四条");
    assert.equal(h.sent[1].payload.count, 3);
    assert.ok(h.sent[1].payload.body.includes("2 条"));
  });

  it("不同用户互不占用冷却", async () => {
    const h = harness({});
    h.d.offer([row("u1", "mention", "a"), row("u2", "mention", "b")]);
    await settle();
    assert.deepEqual(
      h.sent.map((s) => s.endpoint).sort(),
      ["https://push.example/u1", "https://push.example/u2"],
    );
  });

  it("没有订阅设备的用户：攒下的直接丢弃，不留到订阅那一刻灌旧闻", async () => {
    const h = harness({ subs: () => [] });
    h.d.offer([row("u1", "mention", "a")]);
    await settle();
    assert.equal(h.sent.length, 0);
  });
});

describe("没配置时的降级", () => {
  it("offer 是安静的空操作：不发、不抛、不攒", async () => {
    const h = harness({ configured: false });
    assert.equal(h.d.enabled(), false);
    h.d.offer([row("u1", "mention", "a")]);
    h.d.flushDue();
    await settle();
    assert.equal(h.sent.length, 0);
  });
});
