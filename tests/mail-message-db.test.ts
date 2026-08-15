import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { readCode } from "./_source";

/**
 * 读一封信 —— **归属校验是这条链路上唯一错不起的地方**。
 *
 * ═════════════════════════════════════════
 * 它以前根本不存在
 * ═════════════════════════════════════════
 *
 * 库里一直存着 `body_text`，而没有任何地方读它。收到一封信、
 * 看得见主题、**点不开** —— 而抽不出验证码时恰恰最需要看正文
 * （`extractOtp` 宁可不抽也不猜）。
 *
 * 补上这条路的同时，也补上了一个新的暴露面：给一个 id 就能读一封信。
 * 所以下面每一条都在问同一件事的不同侧面：**这封信是不是你的**。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-mailmsg-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

let dbm: typeof import("@/lib/db");
let schema: typeof import("@/lib/db/schema");
let burner: typeof import("@/lib/mail/burner");
let ingest: typeof import("@/lib/mail/ingest");
let seed: typeof import("@/lib/mail/seed-domains");
let message: typeof import("@/lib/mail/message");
let settings: typeof import("@/lib/settings/store");

const ME = "01USER_ME";
const OTHER = "01USER_OTHER";

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  burner = await import("@/lib/mail/burner");
  ingest = await import("@/lib/mail/ingest");
  seed = await import("@/lib/mail/seed-domains");
  message = await import("@/lib/mail/message");
  settings = await import("@/lib/settings/store");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

/** 两个人各开一个箱子，各收一封带验证码的信 */
function scene() {
  for (const t of [
    schema.mailAttachments,
    schema.mailMessages,
    schema.mailSlots,
    // ⚠️ 流水也要清： 的幂等键是「用户 + 第几个」这种确定性的键，
    // 不清的话上一条用例记下的那笔会让下一条直接被判成重复提交。
    // （键确定性在生产里正是对的 —— 连点两下只买到一个。）
    schema.pointsLedger,
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
  for (const id of [ME, OTHER]) {
    dbm.db.insert(schema.users).values({ id, kind: "member", status: "active", ...stamp }).run();
  }
  seed.seedMailDomains();

  const open = (userId: string) => {
    const r = burner.openBurner({ userId });
    assert.ok(r.ok, "开箱失败了，后面的断言就无意义了");
    return r.box;
  };
  const mine = open(ME);
  const theirs = open(OTHER);

  const deliver = (to: string) =>
    ingest.ingestMessage({
      envelopeFrom: "noreply@github.com",
      envelopeTo: to,
      rfcMessageId: `<${to}-${Math.random()}@github.com>`,
      subject: "Your verification code",
      text: "Your code is 824193",
      size: 1024,
    });
  deliver(mine.address);
  deliver(theirs.address);

  const idOf = (boxId: string) =>
    dbm.db
      .select({ id: schema.mailMessages.id })
      .from(schema.mailMessages)
      .where(eq(schema.mailMessages.boxId, boxId))
      .get()!.id;

  return { mine, theirs, myMsg: idOf(mine.id), theirMsg: idOf(theirs.id) };
}

const readAtOf = (id: string) =>
  dbm.db
    .select({ readAt: schema.mailMessages.readAt })
    .from(schema.mailMessages)
    .where(eq(schema.mailMessages.id, id))
    .get()?.readAt ?? null;

beforeEach(() => {});

describe("**只能读自己的信**", () => {
  it("自己的读得到，正文在", () => {
    const s = scene();
    const m = message.readMessage({ userId: ME, messageId: s.myMsg });
    assert.ok(m);
    assert.match(m.bodyText ?? "", /824193/);
    assert.equal(m.toAddress, s.mine.address);
  });

  it("**别人的读不到**", () => {
    const s = scene();
    assert.equal(message.readMessage({ userId: ME, messageId: s.theirMsg }), null);
  });

  it("**「不是你的」和「不存在」给同一个答案** —— 否则它就是个存在性探针", () => {
    /*
     * 两者都返回 null。区分开的话，拿一串 id 挨个试，
     * 靠返回值的差别就能问出「这个 id 存不存在」——
     * 而 id 是可枚举的东西，它不该顺便回答这个问题。
     */
    const s = scene();
    assert.equal(message.readMessage({ userId: ME, messageId: s.theirMsg }), null);
    assert.equal(message.readMessage({ userId: ME, messageId: "根本没有这个" }), null);
  });

  it("**正文清掉的信当作不存在** —— 空白页面最像加载失败", () => {
    /*
     * `purged_at` 是保留期到了之后清正文留元信息的标记。
     * 返回一封没有正文的信，用户看到的是空白，然后他会刷新，
     * 再看一次空白。不如直接说「不在了」。
     */
    const s = scene();
    dbm.db
      .update(schema.mailMessages)
      .set({ purgedAt: Date.now(), bodyText: null })
      .where(eq(schema.mailMessages.id, s.myMsg))
      .run();
    assert.equal(message.readMessage({ userId: ME, messageId: s.myMsg }), null);
  });
});

describe("**读一次就标记已读，而且只标一次**", () => {
  it("第一次读之后 read_at 写上了", () => {
    const s = scene();
    message.readMessage({ userId: ME, messageId: s.myMsg });
    assert.ok(readAtOf(s.myMsg), "没有标记已读");
  });

  it("**返回的是这次打开之前的值** —— 界面靠它决定显不显示「新」", () => {
    /*
     * 返回标记之后的值的话，第一次打开时它已经是「已读」了，
     * 于是那个未读圆点永远不会出现在你真正第一次看到它的那一刻。
     */
    const s = scene();
    assert.equal(message.readMessage({ userId: ME, messageId: s.myMsg })?.readAt, null);
    assert.ok(message.readMessage({ userId: ME, messageId: s.myMsg })?.readAt);
  });

  it("`markRead: false` 不写库 —— 管理员排查不该改用户的未读数", () => {
    const s = scene();
    message.readMessage({ userId: ME, messageId: s.myMsg, markRead: false });
    assert.equal(readAtOf(s.myMsg), null, "只是看一眼也把它标成已读了");
  });

  it("**别人的信连已读都标不上** —— 校验要覆盖到写", () => {
    /*
     * 「这封信是不是你的」和「把它标成已读」如果分成两步，
     * 中间那一刻就有一条路能改别人的信。危害不大，
     * 但它说明校验没有覆盖到写 —— 而下一个加进来的写操作就未必无害了。
     */
    const s = scene();
    message.readMessage({ userId: ME, messageId: s.theirMsg });
    assert.equal(readAtOf(s.theirMsg), null, "标记了别人的信为已读");
  });
});

describe("**网页和接口共用同一份校验**", () => {
  it("两个调用点都走 readMessage，谁都不自己查库", () => {
    /*
     * 各写一遍的话，漏判的方向永远是「把别人的信读出来」，
     * 而那种漏没有任何症状 —— 除非正好读到的是别人的验证码。
     */
    for (const file of [
      "lib/mail/burner-actions.ts",
      "app/api/v1/mail/burners/[id]/messages/[messageId]/route.ts",
    ]) {
      const code = readCode(file);
      assert.match(code, /readMessage\(/, `${file} 没走 readMessage`);
      assert.equal(
        /from\(mailMessages\)/.test(code),
        false,
        `${file} 自己查了 mail_messages —— 校验就有了第二份`,
      );
    }
  });
});

describe("**额度：普通人受限，能管邮箱的人不受限**", () => {
  /*
   * ═════════════════════════════════════════
   * 「不受限」最容易悄悄变成「谁都不受限」
   * ═════════════════════════════════════════
   *
   * 判据是 `mail.box.write`（替别人开箱的那个权限），不是
   * 「是不是管理员」这种笼统说法 —— 额度护的是池域名的命名空间和声誉，
   * 而有权替别人开箱的人本来就能绕开这一层（跑一趟后台就是了）。
   *
   * 这一组盯两个方向：普通人**还被拦着**，以及有权的人**真的不被拦**。
   * 只测后者的话，一个「所有人都 bypass」的写法会全绿。
   */
  const RATE = "mail.burner.per_hour";

  /*
   * 把某个设置临时压成某个值。
   *
   * ⚠️ 写完必须 `invalidateSettingsCache()` —— 设置在进程里是缓存着的
   * （`lib/settings/store.ts`），直接写库的话 `mailConfig()` 读到的
   * 还是旧值，于是这一组测的其实是默认值。第一版就是这么红的。
   */
  const put = (key: string, value: string) => {
    dbm.db
      .insert(schema.settings)
      .values({ key, value, type: "int", category: "mail", updatedAt: Date.now() })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value } })
      .run();
    settings.invalidateSettingsCache();
  };

  /*
   * 并发上限默认是 3，而 `scene()` 已经给 ME 开了一个 ——
   * 不放开的话先撞上的是并发那道闸，这一组测的就不是时限了。
   * 第一版就是这么红的：`code` 是 `concurrent_limit` 而不是 `rate_limit`。
   */
  const roomToSpare = () => put("mail.burner.concurrent_limit", "99");

  it("普通人撞到每小时上限就开不出来了", () => {
    scene();
    roomToSpare();

    /*
     * ⚠️ 从**已经用掉的**那几次算起，不要写死次数。
     *
     * `scene()` 自己就开过一个箱子，也就是已经记了一次 `burner_created`。
     * 写死「前两个该成功」的话，实际上第二个就撞线了 —— 第一版正是这么红的，
     * 而红出来的 code 还是 `concurrent_limit`（那时并发那道闸也没放开），
     * 一个指向完全另一件事的错误。
     */
    const used = dbm.db
      .select()
      .from(schema.mailEvents)
      .all()
      .filter((e) => e.event === "burner_created" && e.actorId === ME).length;
    put(RATE, String(used + 2));

    assert.ok(burner.openBurner({ userId: ME }).ok, "还没到上限就该开得出来");
    assert.ok(burner.openBurner({ userId: ME }).ok, "刚好到上限前那一个也该开得出来");

    const refused = burner.openBurner({ userId: ME });
    assert.equal(refused.ok, false, "超了上限还开得出来");
    if (!refused.ok) assert.equal(refused.code, "rate_limit", "拦下来的不是时限那道闸");
  });

  it("**带 bypassLimits 的开得出来** —— 那条路是给有权的人留的", () => {
    scene();
    roomToSpare();
    // 已经用过一次（scene 里那个），所以上限设成 1 时下一次就该被拦
    put(RATE, "1");

    assert.equal(burner.openBurner({ userId: ME }).ok, false, "普通开箱该被拦");
    assert.ok(
      burner.openBurner({ userId: ME, bypassLimits: true }).ok,
      "bypassLimits 没能绕过额度",
    );
  });

  it("**两个调用点都判了权限** —— 只放开网页的话，站长跑脚本反而被卡", () => {
    /*
     * 网页和 API 各是一条路。只在网页上放开的话，站长用自己的令牌
     * 批量开箱时被卡住 —— 而那正是他最需要批量开箱的场合。
     */
    for (const file of ["lib/mail/burner-actions.ts", "app/api/v1/mail/burners/route.ts"]) {
      const code = readCode(file);
      assert.match(code, /bypassLimits:/, `${file} 没接 bypassLimits`);
      assert.match(code, /can\([^)]*"mail\.box\.write"\)/, `${file} 判的不是 mail.box.write`);
    }
  });

  it("**不受限不等于不留痕** —— 每次开箱都进 mail_events", () => {
    scene();
    const before = dbm.db.select().from(schema.mailEvents).all().length;
    burner.openBurner({ userId: ME, bypassLimits: true });
    const after = dbm.db.select().from(schema.mailEvents).all().length;
    assert.ok(after > before, "绕过额度的那次没有留下事件");
  });
});

describe("**自有域名上的长期地址**", () => {
  /*
   * ═════════════════════════════════════════
   * 唯一的判据是「这域名是不是你的」
   * ═════════════════════════════════════════
   *
   * 公共池上的长期地址是**申领**，那要先有槽位、积分、价格
   * （`mail_slots` 那张表就是为它准备的，现在还零读零写）——
   * 那一整套是另一件事。
   *
   * 而「我自己的域名」不需要任何经济设计：域名是他的，
   * 上面开几个地址是他自己的事。所以这条路只有一个判据，
   * 而这一组就是在从各个方向问那一个判据。
   */
  let alias: typeof import("@/lib/mail/alias");

  const giveDomain = (to: string | null, domain = "mine.icu") => {
    dbm.db
      .insert(schema.mailDomains)
      .values({
        domain,
        punycode: domain,
        kind: "owned",
        status: "active",
        enabled: true,
        ownerUserId: to,
      })
      .onConflictDoUpdate({ target: schema.mailDomains.domain, set: { ownerUserId: to } })
      .run();
    return domain;
  };

  before(async () => {
    alias = await import("@/lib/mail/alias");
  });

  it("自己的域名上开得出来，而且**不过期**", () => {
    scene();
    const d = giveDomain(ME);
    const r = alias.openAlias({ userId: ME, domain: d, localPart: "hello" });
    assert.ok(r.ok, r.ok ? "" : r.error);

    const row = dbm.db
      .select()
      .from(schema.mailBoxes)
      .where(eq(schema.mailBoxes.id, r.box.id))
      .get()!;
    assert.equal(row.kind, "alias");
    assert.equal(row.expiresAt, null, "长期地址不该有到期时间");
    assert.equal(row.muted, false, "长期地址不该静音 —— 别人随时可能给你写信");
  });

  it("★ 关得掉 —— 而且关掉之后收信侧不再认它", () => {
    /*
     * ═════════════════════════════════════════
     * 这个功能原来**整个不存在**
     * ═════════════════════════════════════════
     *
     * 开得出来、关不掉。站长的原话是「还没法删除」——
     * 而自有域名上的地址是免费开的，一个手滑的前缀会永远挂在
     * 他自己的域名上。
     *
     * 走 `revoked` 而不是删行：信是挂在箱子 id 上的，
     * 真删的话已经收到的信要么跟着没（那是他的东西），要么变成孤儿。
     */
    scene();
    const d = giveDomain(ME);
    const opened = alias.openAlias({ userId: ME, domain: d, localPart: "hello" });
    assert.ok(opened.ok, opened.ok ? "" : opened.error);

    const closed = alias.closeAlias({ userId: ME, boxId: opened.box.id });
    assert.equal(closed.ok, true, closed.error ?? "");

    const row = dbm.db
      .select()
      .from(schema.mailBoxes)
      .where(eq(schema.mailBoxes.id, opened.box.id))
      .get()!;
    assert.equal(row.status, "revoked");
    assert.equal(alias.listAliases(ME).length, 0, "关掉之后还出现在列表里");
  });

  it("★ 关不掉别人的地址 —— 而且给的话和「没有这个地址」一样", () => {
    /*
     * 分成两句话写很自然（「不是你的」/「没有这个」），
     * 而那当场就成了一个「这个 id 存不存在」的探针。
     * 和 `readMessage` 是同一条。
     */
    scene();
    const d = giveDomain(OTHER);
    const his = alias.openAlias({ userId: OTHER, domain: d, localPart: "hello" });
    assert.ok(his.ok, his.ok ? "" : his.error);

    const mine = alias.closeAlias({ userId: ME, boxId: his.box.id });
    const ghost = alias.closeAlias({ userId: ME, boxId: "box_根本不存在" });
    assert.equal(mine.ok, false, "关掉了别人的地址");
    assert.equal(mine.error, ghost.error, "两句话不一样 —— 那就成了归属探针");

    const row = dbm.db
      .select()
      .from(schema.mailBoxes)
      .where(eq(schema.mailBoxes.id, his.box.id))
      .get()!;
    assert.equal(row.status, "active", "别人的地址被动了");
  });

  it("**别人的域名上开不出来**", () => {
    scene();
    const d = giveDomain(OTHER);
    const r = alias.openAlias({ userId: ME, domain: d, localPart: "hello" });
    assert.equal(r.ok, false);
  });

  it("**没有主人的域名也开不出来** —— 公共池要走申领那条路", () => {
    scene();
    const d = giveDomain(null);
    assert.equal(alias.openAlias({ userId: ME, domain: d, localPart: "hello" }).ok, false);
  });

  it("**「不是你的」和「没有这个域名」给同一句话** —— 否则它是个归属探针", () => {
    /*
     * 域名列表本身不公开（后台才看得到主人）。分开说的话，
     * 拿一串域名挨个试，靠错误文案就能问出「这个域名有没有主」。
     */
    scene();
    const d = giveDomain(OTHER);
    const a = alias.openAlias({ userId: ME, domain: d, localPart: "hello" });
    const b = alias.openAlias({ userId: ME, domain: "根本没有.icu", localPart: "hello" });
    assert.equal(a.ok, false);
    assert.equal(b.ok, false);
    if (!a.ok && !b.ok) assert.equal(a.error, b.error, "两种情况的说法不一样");
  });

  it("同一个地址开不出第二次", () => {
    scene();
    const d = giveDomain(ME);
    assert.ok(alias.openAlias({ userId: ME, domain: d, localPart: "hello" }).ok);
    assert.equal(alias.openAlias({ userId: ME, domain: d, localPart: "hello" }).ok, false);
  });

  it("**停用的域名开不出来** —— 开了也收不到信", () => {
    scene();
    const d = giveDomain(ME);
    dbm.db
      .update(schema.mailDomains)
      .set({ enabled: false })
      .where(eq(schema.mailDomains.domain, d))
      .run();
    assert.equal(alias.openAlias({ userId: ME, domain: d, localPart: "hello" }).ok, false);
  });

  it("`ownedDomains` 只列自己的、且启用着的", () => {
    scene();
    giveDomain(ME, "mine.icu");
    giveDomain(OTHER, "theirs.icu");
    const mine = alias.ownedDomains(ME).map((d) => d.domain);
    assert.deepEqual(mine, ["mine.icu"]);
  });

  it("**长期地址收得到信** —— 建了个收不到信的地址等于没建", () => {
    scene();
    const d = giveDomain(ME);
    const r = alias.openAlias({ userId: ME, domain: d, localPart: "hello" });
    assert.ok(r.ok);

    ingest.ingestMessage({
      envelopeFrom: "someone@example.com",
      envelopeTo: `hello@${d}`,
      rfcMessageId: "<alias-test@example.com>",
      subject: "写给长期地址",
      text: "你好",
      size: 100,
    });

    const got = dbm.db
      .select()
      .from(schema.mailMessages)
      .where(eq(schema.mailMessages.boxId, r.box.id))
      .all();
    assert.equal(got.length, 1, "长期地址没收到信");
  });
});

describe("**申领：三道闸各防各的**", () => {
  /*
   * ═════════════════════════════════════════
   * 等级防「新号扫光靓号池」，槽位防「一个人囤一堆」，
   * 年租防「买完再也不用而地址永远占着」
   * ═════════════════════════════════════════
   *
   * 少任何一道，剩下两道都拦不住那件事 —— 所以这一组一道一道验。
   */
  let claimQueries: typeof import("@/lib/mail/claim-queries");
  let claim: typeof import("@/lib/mail/claim");
  let ledger: typeof import("@/lib/points/ledger");

  before(async () => {
    claimQueries = await import("@/lib/mail/claim-queries");
    claim = await import("@/lib/mail/claim");
    ledger = await import("@/lib/points/ledger");
  });

  /** 开一个可申领的域名，并给这个人一笔分 */
  const setup = (opts: { tier?: "b" | "a" | "s"; points?: number } = {}) => {
    scene();
    dbm.db
      .insert(schema.mailDomains)
      .values({
        domain: "good.icu",
        punycode: "good.icu",
        kind: "reserved",
        tier: opts.tier ?? "b",
        status: "active",
        enabled: true,
        allowClaim: true,
        allowBurner: false,
      })
      .onConflictDoUpdate({
        target: schema.mailDomains.domain,
        set: { tier: opts.tier ?? "b", allowClaim: true, status: "active" },
      })
      .run();
    if (opts.points) {
      ledger.grantPoints({ userId: ME, delta: opts.points, reason: "测试铺底" });
    }
    return "good.icu";
  };

  it("样样都够就申领得到，而且**扣了年租、给了一年**", () => {
    const d = setup({ tier: "b", points: 5000 });
    const before = dbm.db.select().from(schema.users).where(eq(schema.users.id, ME)).get()!.points;

    const r = claim.claimAddress({ userId: ME, domain: d, localPart: "hello" });
    assert.ok(r.ok, r.ok ? "" : r.error);

    const after = dbm.db.select().from(schema.users).where(eq(schema.users.id, ME)).get()!.points;
    assert.equal(before - after, r.paid, "扣的分和说的不一样");

    const box = dbm.db.select().from(schema.mailBoxes).where(eq(schema.mailBoxes.id, r.boxId)).get()!;
    assert.equal(box.kind, "temp", "申领来的该是长期箱，不是一次性箱");
    assert.ok(box.expiresAt && box.expiresAt > Date.now(), "没给到期时间");
    assert.equal(box.muted, false, "长期地址不该静音");
  });

  it("**分不够就申领不到，而且一分都不扣**", () => {
    /*
     * 最要紧的是后半句。扣了分又没给地址，是这套东西里最容易
     * 让人失去信任的一种失败。
     */
    const d = setup({ tier: "s", points: 10 });
    const before = dbm.db.select().from(schema.users).where(eq(schema.users.id, ME)).get()!.points;
    const r = claim.claimAddress({ userId: ME, domain: d, localPart: "hello" });
    assert.equal(r.ok, false);
    const after = dbm.db.select().from(schema.users).where(eq(schema.users.id, ME)).get()!.points;
    assert.equal(after, before, "申领失败还扣了分");
  });

  it("★ 到期放回池子之后再申领，要**再收一次**年租", () => {
    /*
     * ═════════════════════════════════════════
     * 这一条钉的是幂等键里那个「天」
     * ═════════════════════════════════════════
     *
     * 幂等键原来写的是 `mail.claim:用户:地址` —— 那顺带变成了
     * 「这个人对这个地址**一辈子只扣一次**」：长期箱到期放回池子、
     * 他再申领一次，那一次是免费的。
     * 年租是这套东西里唯一的周期性回收口，一个能被这样绕过的回收口等于没有。
     *
     * 修的时候在键里加了天。而 `scripts/mutate.mjs` 把那个天去掉之后
     * **一条测试都不红** —— 修好了，却没留下守它的东西。
     *
     * 这里直接把那个场景走一遍：申领 → 到期进赎回期 → 原主赎回。
     * 赎回是**原价拿回**，所以第二次必须再扣一次分。
     */
    const d = setup({ tier: "b", points: 5000 });

    /*
     * 两次申领要**隔开一天以上** —— 幂等键里带的是天。
     * 同一天内重复提交本来就该拦（那是双击、是重试），
     * 而隔了一个租期之后的重新申领必须照价收费。
     * 真实场景里这两次隔着一整年，所以这里把 `now` 往前挪一年。
     */
    const YEAR_AGO = Date.now() - 366 * 86_400_000;
    const first = claim.claimAddress({ userId: ME, domain: d, localPart: "again", now: YEAR_AGO });
    assert.ok(first.ok, first.ok ? "" : first.error);
    const afterFirst = dbm.db.select().from(schema.users).where(eq(schema.users.id, ME)).get()!.points;

    /*
     * 做成「已过期、还在 7 天赎回期里」的样子 —— 那是原主拿回它的正路
     * （`redeemUntil` 之外别人也拿不到，见 claim.ts 里那段三情况的说明）。
     */
    dbm.db
      .update(schema.mailBoxes)
      .set({
        status: "expired",
        expiresAt: Date.now() - 86_400_000,
        redeemUntil: Date.now() + 3 * 86_400_000,
      })
      .where(eq(schema.mailBoxes.id, first.boxId!))
      .run();

    const second = claim.claimAddress({ userId: ME, domain: d, localPart: "again" });   // 今天
    assert.ok(second.ok, second.ok ? "" : second.error);
    const afterSecond = dbm.db.select().from(schema.users).where(eq(schema.users.id, ME)).get()!.points;

    assert.equal(
      afterFirst - afterSecond,
      first.paid,
      "同一个地址到期后重新申领是免费的 —— 年租这个回收口被绕过去了",
    );
  });

  it("★ 扣分没成功就不该开出箱子", () => {
    /*
     * 「先扣分再插箱子」这个顺序本身是对的（反过来会出现白拿的箱子），
     * 而这一条钉的是**扣分失败时的返回**：
     * 把 `if (!paid.ok) return …` 删掉，箱子照样开出来 ——
     * 一个没付钱的长期地址，而且分文未动。
     *
     * 用「分不够」来制造扣分失败：canClaim 那一层也会拦，
     * 所以这里把分卡在**刚好够 canClaim 过、但扣的时候不够**是做不到的；
     * 换个角度直接验后果：失败时既不扣分，也不留下箱子。
     */
    const d = setup({ tier: "s", points: 10 });
    const boxesBefore = dbm.db.select().from(schema.mailBoxes).all().length;

    const r = claim.claimAddress({ userId: ME, domain: d, localPart: "nomoney" });
    assert.equal(r.ok, false);

    const boxesAfter = dbm.db.select().from(schema.mailBoxes).all().length;
    assert.equal(boxesAfter, boxesBefore, "申领失败却留下了一个箱子");
  });

  it("★★ 有主域名**不能**被别人从公共池申领 —— 哪怕开关是开的", () => {
    /*
     * ═════════════════════════════════════════
     * 站长报的：「为什么公共池子里包含了私有域名」
     * ═════════════════════════════════════════
     *
     * `claimableDomains` 和 `claimAddress` 原来都只看 `allow_claim`，
     * 不看 `kind` —— 而那个开关在 `owned`（有主域名）上照样能是 1。
     * 线上有三十九个这样的域名挂在公共池里，站长自己的两个就在其中：
     * **任何人攒够分都能在他的域名上开地址。**
     *
     * 而 `openAlias` 那条路守得很严（「唯一的判据：这个域名是不是你的」）——
     * 两条路通向同一张表，只有一条设了闸。
     */
    const d = setup({ tier: "b", points: 5000 });
    dbm.db
      .update(schema.mailDomains)
      .set({ kind: "owned", ownerUserId: OTHER, allowClaim: true })
      .where(eq(schema.mailDomains.domain, d))
      .run();

    const r = claim.claimAddress({ userId: ME, domain: d, localPart: "steal" });
    assert.equal(r.ok, false, "在别人的域名上申领成功了");

    const listed = claimQueries.claimableDomains().map((x) => x.domain);
    assert.equal(listed.includes(d), false, "有主域名出现在公共申领池的列表里");
  });

  it("★ 一次性箱池**可以**长期申领 —— 便宜档基本都在上面", () => {
    /*
     * 这是站长定的：`temp` 那些域名同时也接受长期申领。
     * 代价是它们天天在发一次性地址，长期用的人要知道这一点 ——
     * 那是取舍，不是疏漏。（白名单写在 `kinds.ts` 上。）
     *
     * 这一条钉住它，免得下一次收紧「公共池里都有什么」时
     * 顺手把 temp 一起砍掉。
     */
    const d = setup({ tier: "b", points: 5000 });
    dbm.db
      .update(schema.mailDomains)
      .set({ kind: "temp", allowClaim: true, ownerUserId: null })
      .where(eq(schema.mailDomains.domain, d))
      .run();

    const r = claim.claimAddress({ userId: ME, domain: d, localPart: "okok" });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal(
      claimQueries.claimableDomains().some((x) => x.domain === d),
      true,
      "一次性箱池没有出现在公共申领池里",
    );
  });

  it("★ 只有管理员能开的域名不进公共池", () => {
    const d = setup({ tier: "b", points: 5000 });
    dbm.db
      .update(schema.mailDomains)
      .set({ kind: "admin", allowClaim: true })
      .where(eq(schema.mailDomains.domain, d))
      .run();

    assert.equal(claim.claimAddress({ userId: ME, domain: d, localPart: "x" }).ok, false);
    assert.equal(
      claimQueries.claimableDomains().some((x) => x.domain === d),
      false,
    );
  });

  it("**等级不够时说的是等级**，不是分不够", () => {
    /*
     * S 档要 L4。给足分但等级不够 —— 拒绝理由必须指向等级，
     * 否则他会去攒分，攒够了再撞一次同一堵墙。
     */
    const d = setup({ tier: "s", points: 100 });   // 分不够 400，等级也不够
    const r = claim.claimAddress({ userId: ME, domain: d, localPart: "hello" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /L\d/, `说的不是等级：${r.error}`);
  });

  it("不接受申领的域名申领不了", () => {
    const d = setup({ points: 5000 });
    dbm.db
      .update(schema.mailDomains)
      .set({ allowClaim: false })
      .where(eq(schema.mailDomains.domain, d))
      .run();
    assert.equal(claim.claimAddress({ userId: ME, domain: d, localPart: "hello" }).ok, false);
  });

  it("**同一个地址不会被两个人拿到**", () => {
    const d = setup({ points: 5000 });
    ledger.grantPoints({ userId: OTHER, delta: 5000, reason: "测试铺底" });
    assert.ok(claim.claimAddress({ userId: ME, domain: d, localPart: "hello" }).ok);
    const second = claim.claimAddress({ userId: OTHER, domain: d, localPart: "hello" });
    assert.equal(second.ok, false, "同一个地址被开了两次");
  });

  it("**一次性箱不占槽位** —— 那两件事之间没有任何关系", () => {
    /*
     * 算进来的话，一个人开三个一次性箱就会发现自己申领不了，
     * 而他完全想不明白为什么。
     */
    const d = setup({ points: 5000 });
    const before = claim.slotStatus(ME).used;

    /*
     * ⚠️ 要开到**比槽位总数还多**，否则算进来也看不出差别。
     * 第一版只开了两个，而槽位有好几个 —— 那条断言两种实现下都绿。
     * （是变异测试发现的：把 kind 改成 ["temp","burner"] 没有红。）
     */
    const total = claim.slotStatus(ME).total;
    for (let i = 0; i < total + 2; i++) burner.openBurner({ userId: ME, bypassLimits: true });

    assert.equal(claim.slotStatus(ME).used, before, "一次性箱占了槽位");
    assert.ok(
      claim.claimAddress({ userId: ME, domain: d, localPart: "hello" }).ok,
      "开了一堆一次性箱之后就申领不了了 —— 那两件事之间没有任何关系",
    );
  });

  it("**槽位用完就申领不了** —— 而理由要指向槽位", () => {
    const d = setup({ points: 99999 });
    // 一路开到槽位用完
    let last: ReturnType<typeof claim.claimAddress> | null = null;
    for (let i = 0; i < 12; i++) {
      last = claim.claimAddress({ userId: ME, domain: d, localPart: `addr${i}${i}` });
      if (!last.ok) break;
    }
    assert.ok(last && !last.ok, "开了十二个都没撞到槽位上限");
    if (last && !last.ok) assert.match(last.error, /槽位/, `说的不是槽位：${last.error}`);
  });

  it("**先扣分再建箱** —— 顺序反了的话，扣分失败时地址已经发出去了", () => {
    /*
     * 地址是唯一命名的：回滚意味着把一个已经显示给用户看过的地址收回去。
     * 而扣了分建箱失败好办得多 —— 冲正那一笔，账面上什么都没发生。
     *
     * 这一条读源码而不是构造失败：要在真库上让 insert 失败又不让
     * 前面那些检查先拦下来，得挖一个很假的场景，而那种测试
     * 保护的是那个场景本身，不是这条顺序。
     */
    const code = readCode("lib/mail/claim.ts");
    const paidAt = code.indexOf("const paid = grantPoints(");
    const insertAt = code.indexOf(".insert(mailBoxes)");
    assert.notEqual(paidAt, -1, "找不到扣分那一步");
    assert.notEqual(insertAt, -1, "找不到建箱那一步");
    assert.ok(paidAt < insertAt, "建箱排在扣分前面了");
    // 而且扣分失败必须当场返回，不能往下走
    assert.match(code, /if \(!paid\.ok\) return/, "扣分失败之后还往下走了");
  });

  it("申领之后槽位用量涨了一个", () => {
    const d = setup({ points: 5000 });
    const before = claim.slotStatus(ME).used;
    assert.ok(claim.claimAddress({ userId: ME, domain: d, localPart: "hello" }).ok);
    assert.equal(claim.slotStatus(ME).used, before + 1);
  });
});

describe("**到期 → 宽限期 → 放回池子**", () => {
  /*
   * ═════════════════════════════════════════
   * 邮箱的宽限期是必需的，不是体贴
   * ═════════════════════════════════════════
   *
   * 称号到期只是不能佩戴；而邮箱到期被别人抢走的话，
   * **别人会开始收到本该给你的邮件** —— 那不是失去一个装饰，
   * 是一条还在被使用的身份线被接管。
   */
  let claim: typeof import("@/lib/mail/claim");
  let settle: typeof import("@/lib/mail/settle");
  let ledger: typeof import("@/lib/points/ledger");
  let rules: typeof import("@/lib/mail/slot-rules");

  before(async () => {
    claim = await import("@/lib/mail/claim");
    settle = await import("@/lib/mail/settle");
    ledger = await import("@/lib/points/ledger");
    rules = await import("@/lib/mail/slot-rules");
  });

  const DAY = 86_400_000;

  /** 申领一个，并把它的到期日推到过去 */
  const expired = () => {
    scene();
    dbm.db
      .insert(schema.mailDomains)
      .values({
        domain: "good.icu",
        punycode: "good.icu",
        kind: "reserved",
        tier: "b",
        status: "active",
        enabled: true,
        allowClaim: true,
      })
      .onConflictDoUpdate({ target: schema.mailDomains.domain, set: { allowClaim: true } })
      .run();
    ledger.grantPoints({ userId: ME, delta: 5000, reason: "测试铺底" });
    const r = claim.claimAddress({ userId: ME, domain: "good.icu", localPart: "hello" });
    assert.ok(r.ok, r.ok ? "" : r.error);
    dbm.db
      .update(schema.mailBoxes)
      .set({ expiresAt: Date.now() - DAY })
      .where(eq(schema.mailBoxes.id, r.boxId))
      .run();
    return r.boxId;
  };

  const boxOf = (id: string) =>
    dbm.db.select().from(schema.mailBoxes).where(eq(schema.mailBoxes.id, id)).get();

  it("到期先进宽限期，**地址还在、信照收**", () => {
    const id = expired();
    settle.settleMail();
    const b = boxOf(id);
    assert.ok(b, "到期就把箱子删了 —— 别人会开始收到本该给他的邮件");
    assert.equal(b.status, "grace");
    assert.ok(b.graceUntil && b.graceUntil > Date.now(), "没记宽限期到哪天");
  });

  it("**宽限期不会每天往后延** —— 只挑 active 的进", () => {
    /*
     * 已经在宽限期里的又被计一次的话，它的宽限期会每天延一天，
     * 于是永远不会真正到期 —— 一个「放不回池子」的池子。
     */
    const id = expired();
    settle.settleMail();
    const first = boxOf(id)!.graceUntil;
    settle.settleMail();
    assert.equal(boxOf(id)!.graceUntil, first, "宽限期被延后了");
  });

  it("宽限期里续上就原样恢复", () => {
    const id = expired();
    settle.settleMail();
    assert.equal(boxOf(id)!.status, "grace");

    const r = claim.renewClaim({ userId: ME, boxId: id });
    assert.ok(r.ok, r.ok ? "" : r.error);
    const b = boxOf(id)!;
    assert.equal(b.status, "active", "续上了还是一副快没了的样子");
    assert.equal(b.graceUntil, null);
    assert.ok(b.expiresAt! > Date.now());
    assert.equal(b.renewCount, 1);
  });

  it("**续期从原到期日顺延** —— 提前续费不吃亏", () => {
    scene();
    const now = 1_000 * DAY;
    const future = now + 100 * DAY;
    assert.equal(rules.renewedExpiry(future, now), future + rules.RENT_DAYS * DAY);
  });

  it("**宽限期满进赎回期，不是直接放回池子** —— 而信这时就删", () => {
    /*
     * ═════════════════════════════════════════
     * 两个窗口，两件不同的事
     * ═════════════════════════════════════════
     *
     *   宽限期（30 天）  地址**仍然是他的**，信照收，别人抢不走
     *   赎回期（7 天）   地址**已经不是他的了**，但别人也还拿不到
     *
     * 信在进赎回期时就删：赎回回来的是**地址**，不是历史。
     * 留着的话，万一最后是别人拿到了它，那些信就到了别人手里。
     */
    const id = expired();
    settle.settleMail();
    dbm.db
      .update(schema.mailBoxes)
      .set({ graceUntil: Date.now() - DAY })
      .where(eq(schema.mailBoxes.id, id))
      .run();
    ingest.ingestMessage({
      envelopeFrom: "x@example.com",
      envelopeTo: "hello@good.icu",
      rfcMessageId: "<grace@example.com>",
      subject: "宽限期里收到的",
      text: "还收得到",
      size: 10,
    });

    settle.settleMail();
    const b = boxOf(id);
    assert.ok(b, "宽限期一满就把行删了 —— 原主的 7 天优先权没了");
    assert.equal(b.status, "expired");
    assert.ok(b.redeemUntil && b.redeemUntil > Date.now(), "没记赎回期到哪天");

    const left = dbm.db
      .select()
      .from(schema.mailMessages)
      .where(eq(schema.mailMessages.boxId, id))
      .all();
    assert.equal(left.length, 0, "进赎回期了信还留着 —— 万一被别人拿到，信就到别人手里了");
  });

  it("**赎回期也过了才真的删行** —— 留着行别人根本申领不了", () => {
    /*
     * 地址的唯一性靠 `address` 上那个唯一索引保证。
     * 「放回池子」这句话的全部意思就是别人能拿到它。
     */
    const id = expired();
    settle.settleMail();
    dbm.db
      .update(schema.mailBoxes)
      .set({ graceUntil: Date.now() - DAY })
      .where(eq(schema.mailBoxes.id, id))
      .run();
    settle.settleMail();
    dbm.db
      .update(schema.mailBoxes)
      .set({ redeemUntil: Date.now() - DAY })
      .where(eq(schema.mailBoxes.id, id))
      .run();
    settle.settleMail();
    assert.equal(boxOf(id), undefined, "赎回期过了还占着地址");
  });

  it("**续期不查等级也不查槽位** —— 掉级就续不了费是最糟的结果", () => {
    /*
     * 那两道闸防的是「拿到新地址」。这个地址已经是他的了 ——
     * 因为掉了一级就续不了、然后被别人抢走，是这套规则能造出的
     * 最糟的一种结果。
     */
    const code = readCode("lib/mail/claim.ts");
    const fn = code.slice(code.indexOf("export function renewClaim"));
    assert.equal(/canClaim\(/.test(fn), false, "续期也去查三道闸了");
    assert.equal(/slotStatus\(/.test(fn), false, "续期也去查槽位了");
  });
});

describe("**申领来的地址要能被看见**", () => {
  /*
   * ═════════════════════════════════════════
   * 它以前一处都不显示
   * ═════════════════════════════════════════
   *
   * `listAliases` 只查 `alias`、`listBurners` 只查 `burner`，
   * 而申领来的是 `temp` —— 也就是说申领成功之后，那个地址
   * **在界面上一处都不出现**：花了 400 分，然后它消失了。
   *
   * 这一组盯的是「三种箱子各有各的列表，而且合起来不漏」。
   */
  let claim: typeof import("@/lib/mail/claim");
  let alias: typeof import("@/lib/mail/alias");
  let ledger: typeof import("@/lib/points/ledger");

  before(async () => {
    claim = await import("@/lib/mail/claim");
    alias = await import("@/lib/mail/alias");
    ledger = await import("@/lib/points/ledger");
  });

  const claimOne = () => {
    scene();
    dbm.db
      .insert(schema.mailDomains)
      .values({
        domain: "good.icu",
        punycode: "good.icu",
        kind: "reserved",
        tier: "b",
        status: "active",
        enabled: true,
        allowClaim: true,
      })
      .onConflictDoUpdate({ target: schema.mailDomains.domain, set: { allowClaim: true } })
      .run();
    ledger.grantPoints({ userId: ME, delta: 5000, reason: "测试铺底" });
    const r = claim.claimAddress({ userId: ME, domain: "good.icu", localPart: "hello" });
    assert.ok(r.ok, r.ok ? "" : r.error);
    return r;
  };

  it("申领完就在 listClaimed 里，带着到期日和价格", () => {
    const r = claimOne();
    const list = claim.listClaimed(ME);
    assert.equal(list.length, 1, "申领来的地址一处都不显示");
    assert.equal(list[0].address, r.address);
    assert.ok(list[0].expiresAt, "没有到期日");
    assert.ok(list[0].rent > 0, "没带续期价格 —— 界面就得自己按档位查价，那是第二份价目表");
    assert.ok(list[0].daysLeft && list[0].daysLeft > 300, "剩余天数不对");
  });

  it("**三种箱子各归各的列表，互不串**", () => {
    /*
     * 串了的话最容易出的错是「一次性箱出现在长期地址那一栏、
     * 带着一个续期按钮」—— 而一次性箱是不能续期的。
     */
    claimOne();
    burner.openBurner({ userId: ME });
    assert.equal(claim.listClaimed(ME).length, 1);
    assert.equal(alias.listAliases(ME).length, 0, "自有域名那一栏混进了别的");
    assert.equal(burner.listBurners({ userId: ME }).length, 1);
  });

  it("**别人的申领地址看不到**", () => {
    claimOne();
    assert.equal(claim.listClaimed(OTHER).length, 0);
  });

  it("**天数在服务端算** —— 客户端算的话跟着用户的机器时间走", () => {
    /*
     * 他把系统时间调快一天，页面上就显示地址明天到期。
     * 而这一栏唯一会让人后悔的事就是错过续期。
     */
    const code = readCode("components/mail/ClaimedSection.tsx");
    assert.equal(/Date\.now\(\)/.test(code), false, "组件里又自己读时钟了");
    assert.match(code, /box\.daysLeft/, "没用服务端算好的天数");
  });
});

describe("**赎回期：原主 7 天优先权**", () => {
  let claim: typeof import("@/lib/mail/claim");
  let settle: typeof import("@/lib/mail/settle");
  let ledger: typeof import("@/lib/points/ledger");
  const DAY = 86_400_000;

  before(async () => {
    claim = await import("@/lib/mail/claim");
    settle = await import("@/lib/mail/settle");
    ledger = await import("@/lib/points/ledger");
  });

  /** 申领一个，然后一路推到赎回期 */
  const intoRedeem = () => {
    scene();
    dbm.db
      .insert(schema.mailDomains)
      .values({
        domain: "good.icu",
        punycode: "good.icu",
        kind: "reserved",
        tier: "b",
        status: "active",
        enabled: true,
        allowClaim: true,
      })
      .onConflictDoUpdate({ target: schema.mailDomains.domain, set: { allowClaim: true } })
      .run();
    for (const u of [ME, OTHER]) ledger.grantPoints({ userId: u, delta: 5000, reason: "测试铺底" });

    const r = claim.claimAddress({ userId: ME, domain: "good.icu", localPart: "hello" });
    assert.ok(r.ok, r.ok ? "" : r.error);
    dbm.db
      .update(schema.mailBoxes)
      .set({ expiresAt: Date.now() - DAY })
      .where(eq(schema.mailBoxes.id, r.boxId))
      .run();
    settle.settleMail();
    dbm.db
      .update(schema.mailBoxes)
      .set({ graceUntil: Date.now() - DAY })
      .where(eq(schema.mailBoxes.id, r.boxId))
      .run();
    settle.settleMail();
    return r.boxId;
  };

  it("**赎回期里别人拿不到，而且要说清楚什么时候能拿**", () => {
    /*
     * 只说「暂时不能申领」的话，他只能每天来试一次 ——
     * 而这个地址他可能已经等了一个月。
     */
    intoRedeem();
    const r = claim.claimAddress({ userId: OTHER, domain: "good.icu", localPart: "hello" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /\d/, `没给日期：${r.error}`);
  });

  it("**原主原价拿得回来**，而且是同一行不是新开一个", () => {
    const id = intoRedeem();
    const r = claim.claimAddress({ userId: ME, domain: "good.icu", localPart: "hello" });
    assert.ok(r.ok, r.ok ? "" : r.error);
    if (r.ok) assert.equal(r.boxId, id, "赎回开成了新的一行 —— address 上有唯一索引，这会撞");

    const b = dbm.db.select().from(schema.mailBoxes).where(eq(schema.mailBoxes.id, id)).get()!;
    assert.equal(b.status, "active");
    assert.equal(b.redeemUntil, null, "赎回回来了还留着赎回期");
    assert.ok(b.expiresAt! > Date.now());
  });

  it("赎回期过了之后别人就拿得到了", () => {
    const id = intoRedeem();
    dbm.db
      .update(schema.mailBoxes)
      .set({ redeemUntil: Date.now() - DAY })
      .where(eq(schema.mailBoxes.id, id))
      .run();
    settle.settleMail();
    const r = claim.claimAddress({ userId: OTHER, domain: "good.icu", localPart: "hello" });
    assert.ok(r.ok, r.ok ? "" : r.error);
  });
});

describe("**买槽位**", () => {
  let claim: typeof import("@/lib/mail/claim");
  let ledger: typeof import("@/lib/points/ledger");
  let rules: typeof import("@/lib/mail/slot-rules");

  before(async () => {
    claim = await import("@/lib/mail/claim");
    ledger = await import("@/lib/points/ledger");
    rules = await import("@/lib/mail/slot-rules");
  });

  it("买一个，槽位总数涨一个，而且真的落了一行", () => {
    /*
     * `mail_slots` 那张表在这之前**只被读、从没被写过** ——
     * 算出来的「买来的」永远是 0。
     */
    scene();
    ledger.grantPoints({ userId: ME, delta: 5000, reason: "测试铺底" });
    const before = claim.slotStatus(ME).total;
    const r = claim.buySlot({ userId: ME });
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.equal(claim.slotStatus(ME).total, before + 1);
    assert.equal(dbm.db.select().from(schema.mailSlots).all().length, 1);
  });

  it(`**最多 ${3} 个** —— 没有上限就是「钱能买断」`, () => {
    scene();
    ledger.grantPoints({ userId: ME, delta: 99999, reason: "测试铺底" });
    for (let i = 0; i < rules.PURCHASED_SLOT_CAP; i++) {
      assert.ok(claim.buySlot({ userId: ME }).ok, `第 ${i + 1} 个该买得到`);
    }
    assert.equal(claim.buySlot({ userId: ME }).ok, false, "买到第四个了");
  });

  it("**分不够就买不到，而且一分不扣**", () => {
    scene();
    const before = dbm.db.select().from(schema.users).where(eq(schema.users.id, ME)).get()!.points;
    assert.equal(claim.buySlot({ userId: ME }).ok, false);
    const after = dbm.db.select().from(schema.users).where(eq(schema.users.id, ME)).get()!.points;
    assert.equal(after, before);
  });

  it("**连点两下只买到一个** —— 幂等键挡下的那次不能再插一行", () => {
    /*
     * `grantPoints` 对重复的键返回 `{ ok: true, duplicate: true }` ——
     * 那是「这笔账已经记过了」，不是「又记了一笔」。
     * 不看这个标志的话，连点两下会扣一次分、拿到两个槽位。
     *
     * ⚠️ 要**真的再调一次 `buySlot`**，不能手工去调 `grantPoints`。
     * 第一版就是那么写的，于是它绕开了被测的那条路 ——
     * 把 `if (paid.duplicate) return` 整行删掉，那条测试照样绿。
     * （变异测试发现的。）
     *
     * 真实的并发形状是：两次调用都看到 `owned === 0`，
     * 于是都算出同一个幂等键。这里用一次成功 + 一次强行同键来模拟。
     */
    scene();
    ledger.grantPoints({ userId: ME, delta: 5000, reason: "测试铺底" });
    const balance = () =>
      dbm.db.select().from(schema.users).where(eq(schema.users.id, ME)).get()!.points;
    const before = balance();

    assert.ok(claim.buySlot({ userId: ME }).ok);
    // 把刚落的那一行撤掉，让第二次调用重新算出**同一个**幂等键 ——
    // 这正是两个并发请求都读到 owned=0 时的样子
    dbm.db.delete(schema.mailSlots).run();

    const again = claim.buySlot({ userId: ME });
    assert.ok(again.ok, "第二次调用不该报错，它只是撞上了幂等键");
    assert.equal(
      dbm.db.select().from(schema.mailSlots).all().length,
      0,
      "幂等键挡下的那次又插了一行槽位 —— 扣一次分拿两个槽位",
    );
    assert.equal(before - balance(), rules.SLOT_PRICE, "重复提交多扣了分");
  });
});


describe("**附件下载：只能取自己的**", () => {
  /*
   * 附件比正文更要紧：正文里的验证码几分钟就失效了，
   * 而一个附件可能是一份合同、一张身份证照片。
   *
   * ⚠️ 这一组是补出来的 —— 原来只有「代码里走没走 readAttachment」
   * 那种源码断言，而把归属过滤整条删掉之后它照样绿。
   * 源码断言管的是「有没有第二份实现」，管不了「那一份对不对」。
   */
  let store: typeof import("@/lib/mail/attachment-store");

  before(async () => {
    store = await import("@/lib/mail/attachment-store");
  });

  /** 给某个人的箱子塞一封带附件的信，返回附件 id */
  const withAttachment = (opts: { stored: boolean } = { stored: true }) => {
    const s = scene();
    const msgId = s.myMsg;
    dbm.db
      .insert(schema.mailAttachments)
      .values({
        id: `att_${opts.stored ? "s" : "n"}`,
        messageId: msgId,
        filename: "note.txt",
        mime: "text/plain",
        size: 5,
        stored: opts.stored,
        content: opts.stored ? Buffer.from("hello") : null,
      })
      .run();
    return { id: `att_${opts.stored ? "s" : "n"}`, ...s };
  };

  it("自己的取得到，内容对得上", () => {
    const a = withAttachment();
    const got = store.readAttachment({ userId: ME, attachmentId: a.id });
    assert.ok(got, "自己的附件取不到");
    assert.equal(got.filename, "note.txt");
    assert.equal(got.content.toString(), "hello");
  });

  it("**别人的取不到**", () => {
    const a = withAttachment();
    assert.equal(store.readAttachment({ userId: OTHER, attachmentId: a.id }), null);
  });

  it("**没存下来的取不到** —— 而不是给一个空文件", () => {
    /*
     * 返回一个 0 字节的文件的话，人会以为附件坏了；
     * 而实际情况是它从来没被保存过（等级不够或者太大）。
     */
    const a = withAttachment({ stored: false });
    assert.equal(store.readAttachment({ userId: ME, attachmentId: a.id }), null);
  });

  it("**不存在的和别人的给同一个答案**", () => {
    const a = withAttachment();
    assert.equal(store.readAttachment({ userId: OTHER, attachmentId: a.id }), null);
    assert.equal(store.readAttachment({ userId: ME, attachmentId: "根本没有" }), null);
  });
});
