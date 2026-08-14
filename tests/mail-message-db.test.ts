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
