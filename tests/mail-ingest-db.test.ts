import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { and, eq } from "drizzle-orm";

/**
 * 收信与一次性箱 —— 接上真库之后。
 *
 * 这一组盯的是三件在纯逻辑层测不到、而错了会很难查的事：
 *   · **中文域名**：信封上是 A 标签，库里存的是 U 标签，对不上就静默收不到信
 *   · **拒掉的也要留痕**：「我朋友说发了我没收到」这句话唯一的抓手
 *   · **额度网页和 API 共用**：分开算等于没有上限
 */

const tmp = mkdtempSync(join(tmpdir(), "al-mailingest-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

let dbm: typeof import("@/lib/db");
let schema: typeof import("@/lib/db/schema");
let burner: typeof import("@/lib/mail/burner");
let ingest: typeof import("@/lib/mail/ingest");
let seed: typeof import("@/lib/mail/seed-domains");

const USER = "01USER_TESTER";
const OTHER = "01USER_OTHER";
const TOKEN_A = "01TOKEN_A";
const TOKEN_B = "01TOKEN_B";

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  burner = await import("@/lib/mail/burner");
  ingest = await import("@/lib/mail/ingest");
  seed = await import("@/lib/mail/seed-domains");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  for (const t of [
    schema.mailMessages,
    schema.mailIngressLog,
    schema.mailEvents,
    schema.mailBoxes,
    schema.mailBlocks,
    schema.mailDomains,
    schema.mailBanwords,
    schema.settings,
    schema.users,
  ]) {
    dbm.db.delete(t).run();
  }
  const stamp = { createdAt: Date.now(), updatedAt: Date.now() };
  for (const id of [USER, OTHER]) {
    dbm.db.insert(schema.users).values({ id, kind: "member", status: "active", ...stamp }).run();
  }
  seed.seedMailDomains();
});

const deliver = (to: string, extra: Partial<import("@/lib/mail/ingest").InboundMessage> = {}) =>
  ingest.ingestMessage({
    envelopeFrom: "noreply@github.com",
    envelopeTo: to,
    rfcMessageId: `<${Math.random()}@github.com>`,
    subject: "Your verification code",
    text: "Your code is 824193",
    size: 1024,
    ...extra,
  });

describe("开一次性箱", () => {
  it("随机地址开得出来，落在轮换里的域名上", () => {
    const r = burner.openBurner({ userId: USER });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.match(r.box.address, /^[a-z0-9]{12}@[a-z0-9.-]+\.icu$/);
    assert.equal(r.box.custom, false);
  });

  it("自选前缀够长就能用", () => {
    const r = burner.openBurner({ userId: USER, localPart: "my-signup-alias" });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.box.localPart, "my-signup-alias");
  });

  it("自选前缀太短被拒 —— 短前缀留给正式申领", () => {
    const r = burner.openBurner({ userId: USER, localPart: "hi" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "bad_local");
  });

  it("禁用词挡得住", () => {
    const r = burner.openBurner({ userId: USER, localPart: "administrator" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "bad_local");
  });

  it("★ 站长可以绕过长度和禁用词", () => {
    const r = burner.openBurner({ userId: USER, localPart: "admin", bypassLimits: true });
    assert.equal(r.ok, true);
  });

  it("★ 靓号域名开不出一次性箱 —— 这是靓号值钱的全部原因", () => {
    const r = burner.openBurner({ userId: USER, domain: "tsuki.icu" });
    assert.equal(r.ok, false);
  });

  it("★ 站长挪进来的那四个不许自选前缀", () => {
    const random = burner.openBurner({ userId: USER, domain: "camhub.icu" });
    assert.equal(random.ok, true, "随机的可以");

    const custom = burner.openBurner({
      userId: USER,
      domain: "camhub.icu",
      localPart: "somethinglong",
    });
    assert.equal(custom.ok, false, "自选的不行");
    if (!custom.ok) assert.equal(custom.code, "custom_not_allowed");
  });

  it("★ 同时在手的上限是网页和 API 共用的一个数", () => {
    // 分开算的话「网页 3 个 + 每把令牌 3 个」等于没有上限
    assert.equal(burner.openBurner({ userId: USER }).ok, true);
    assert.equal(burner.openBurner({ userId: USER, tokenId: TOKEN_A }).ok, true);
    assert.equal(burner.openBurner({ userId: USER, tokenId: TOKEN_B }).ok, true);

    const fourth = burner.openBurner({ userId: USER, tokenId: TOKEN_A });
    assert.equal(fourth.ok, false);
    if (!fourth.ok) assert.equal(fourth.code, "concurrent_limit");
  });

  it("销毁之后能再开 —— 而且地址可以被重新发出去", () => {
    const first = burner.openBurner({ userId: USER, localPart: "reusable-name" });
    assert.equal(first.ok, true);
    if (!first.ok) return;

    burner.destroyBurner(first.box.id, { userId: USER });

    const again = burner.openBurner({
      userId: USER,
      localPart: "reusable-name",
      domain: first.box.domain,
    });
    assert.equal(again.ok, true, "部分唯一索引把 revoked 排除在外，地址才能回收");
  });
});

describe("令牌的作用域", () => {
  it("★ 一把令牌只看得到自己开的箱子", () => {
    burner.openBurner({ userId: USER, tokenId: TOKEN_A });
    burner.openBurner({ userId: USER, tokenId: TOKEN_B });
    burner.openBurner({ userId: USER });

    assert.equal(burner.listBurners({ userId: USER }).length, 3, "网页看得到全部");
    assert.equal(
      burner.listBurners({ userId: USER, tokenId: TOKEN_A }).length,
      1,
      "泄漏一把令牌的爆炸半径只是它自己造的地址",
    );
  });

  it("拿不到别人的箱子", () => {
    const mine = burner.openBurner({ userId: USER });
    assert.equal(mine.ok, true);
    if (!mine.ok) return;
    assert.equal(burner.getOwnedBurner(mine.box.id, { userId: OTHER }), undefined);
  });
});

describe("收信", () => {
  it("投到一个存在的地址就落进去，并抽出验证码", () => {
    const box = burner.openBurner({ userId: USER });
    assert.equal(box.ok, true);
    if (!box.ok) return;

    const r = deliver(box.box.address);
    assert.equal(r.verdict, "accepted");

    const msgs = burner.listBurnerMessages(box.box.id);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].otpCode, "824193", "验证码是这个功能好不好用的分水岭");
  });

  it("★ 中文域名：信封上是 A 标签也认得出来", () => {
    const box = burner.openBurner({ userId: USER, domain: "华立.icu" });
    assert.equal(box.ok, true);
    if (!box.ok) return;

    assert.match(box.box.address, /@xn--xkrw23g\.icu$/, "信封地址必须是 punycode");
    assert.equal(box.box.displayAddress.endsWith("@华立.icu"), true, "给人看的是中文");

    assert.equal(deliver(box.box.address).verdict, "accepted");
  });

  it("★ 地址不存在时拒掉，而且留痕", () => {
    const r = deliver("nobody-here@rickroll.icu");
    assert.equal(r.verdict, "rejected");

    const log = dbm.db.select().from(schema.mailIngressLog).all();
    assert.equal(log.length, 1);
    assert.equal(log[0].verdict, "rejected");
    assert.match(log[0].reason ?? "", /不存在/);
  });

  it("★ 管理员专用域名：地址不存在时拒，但**留痕** —— 这就是配 MX 换来的", () => {
    // 发到 security@githubusercontent.icu 的每一次试探都看得见
    const r = deliver("security@githubusercontent.icu");
    assert.equal(r.verdict, "rejected");
    assert.match(r.reason, /不存在/, "不该是「域名被封禁」——那一档已经不用了");

    const log = dbm.db.select().from(schema.mailIngressLog).all();
    assert.equal(log.length, 1);
    assert.equal(log[0].envelopeTo, "security@githubusercontent.icu");
  });

  it("★ 管理员在那种域名上开的地址收得到信", () => {
    const box = burner.openBurner({
      userId: USER,
      domain: "githubusercontent.icu",
      localPart: "watchtower",
      bypassLimits: true,
    });
    assert.equal(box.ok, true, "管理员该开得出来");
    if (!box.ok) return;
    assert.equal(deliver(box.box.address).verdict, "accepted");
  });

  it("★ 但普通成员在那种域名上一个都开不出来", () => {
    const r = burner.openBurner({ userId: USER, domain: "githubusercontent.icu" });
    assert.equal(r.ok, false);
  });

  it("超大的信在落盘前就拒掉", () => {
    const box = burner.openBurner({ userId: USER });
    if (!box.ok) return;
    const r = deliver(box.box.address, { size: 999_999_999 });
    assert.equal(r.verdict, "rejected");
  });

  it("★ 网关重投同一封不会存两份", () => {
    const box = burner.openBurner({ userId: USER });
    if (!box.ok) return;

    const id = "<dup@github.com>";
    assert.equal(deliver(box.box.address, { rfcMessageId: id }).verdict, "accepted");
    assert.equal(deliver(box.box.address, { rfcMessageId: id }).verdict, "accepted");

    assert.equal(burner.listBurnerMessages(box.box.id).length, 1);
  });

  it("发件人黑名单挡得住", () => {
    const box = burner.openBurner({ userId: USER });
    if (!box.ok) return;

    dbm.db
      .insert(schema.mailBlocks)
      .values({ scope: "global", matchKind: "sender_domain", pattern: "spam.example" })
      .run();

    const r = deliver(box.box.address, { envelopeFrom: "x@spam.example" });
    assert.equal(r.verdict, "rejected");
  });

  it("用量和计数跟着涨", () => {
    const box = burner.openBurner({ userId: USER });
    if (!box.ok) return;
    deliver(box.box.address, { size: 2048 });

    const row = dbm.db
      .select()
      .from(schema.mailBoxes)
      .where(eq(schema.mailBoxes.id, box.box.id))
      .get();
    assert.equal(row?.usedBytes, 2048);
    assert.equal(row?.messageCount, 1);
    assert.equal(row?.unreadCount, 1);
  });

  it("★ 箱子满了拒收并标成 full —— 不静默丢", () => {
    const box = burner.openBurner({ userId: USER });
    if (!box.ok) return;

    dbm.db
      .update(schema.mailBoxes)
      .set({ usedBytes: 5 * 1024 * 1024 })
      .where(eq(schema.mailBoxes.id, box.box.id))
      .run();

    const r = deliver(box.box.address);
    assert.equal(r.verdict, "rejected");
    assert.match(r.reason, /满/);

    const row = dbm.db
      .select()
      .from(schema.mailBoxes)
      .where(eq(schema.mailBoxes.id, box.box.id))
      .get();
    assert.equal(row?.status, "full");
  });

  it("销毁掉的箱子不再收信", () => {
    const box = burner.openBurner({ userId: USER });
    if (!box.ok) return;
    burner.destroyBurner(box.box.id, { userId: USER });
    assert.equal(deliver(box.box.address).verdict, "rejected");
  });
});

describe("到期回收", () => {
  it("到点直接销毁，正文一起清掉 —— 一次性就是一次性", () => {
    const box = burner.openBurner({ userId: USER });
    if (!box.ok) return;
    deliver(box.box.address);

    dbm.db
      .update(schema.mailBoxes)
      .set({ expiresAt: Date.now() - 1000 })
      .where(eq(schema.mailBoxes.id, box.box.id))
      .run();

    assert.equal(burner.reclaimExpiredBurners(), 1);

    const row = dbm.db
      .select()
      .from(schema.mailBoxes)
      .where(eq(schema.mailBoxes.id, box.box.id))
      .get();
    assert.equal(row?.status, "expired");
    assert.equal(burner.listBurnerMessages(box.box.id).length, 0);
  });

  it("没到期的不动", () => {
    burner.openBurner({ userId: USER });
    assert.equal(burner.reclaimExpiredBurners(), 0);
  });

  it("★ 到期的箱子不占「同时在手」的额度", () => {
    for (let i = 0; i < 3; i++) burner.openBurner({ userId: USER });
    assert.equal(burner.openBurner({ userId: USER }).ok, false);

    dbm.db
      .update(schema.mailBoxes)
      .set({ expiresAt: Date.now() - 1000 })
      .where(and(eq(schema.mailBoxes.userId, USER), eq(schema.mailBoxes.kind, "burner")))
      .run();

    // 清理还没跑，但判定不能等它 —— 否则用户要盯着一个 5 分钟才跑一次的定时任务
    assert.equal(burner.countLiveBurners(USER), 0);
  });
});
