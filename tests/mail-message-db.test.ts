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
