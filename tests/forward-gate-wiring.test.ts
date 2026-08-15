import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it, mock } from "node:test";

/**
 * 转发那四道闸：**判定拿到之后有没有照做**。
 *
 * ═════════════════════════════════════════
 * 规则测得很足，而「照不照做」没人守
 * ═════════════════════════════════════════
 *
 * `forward-rules.ts` 里四道闸各自都有测试（没验证过的地址、
 * 转到自己的域名、频率上限、等级），改任何一条都会红。
 *
 * 而 `scripts/mutate.mjs` 把 `forward.ts` 里那句
 * `if (refusal) { …记事件… return; }` 改成 `if (false)` ——
 * 判定照常算出来，然后被**扔掉**，信照发不误。一条测试都不红。
 *
 * 这正是 `forward-rules.ts` 顶上那段警告的东西：
 * 「转发最容易出的错是把自己变成开放中继……几天之内被拿去发垃圾，
 * 然后我们的域名进黑名单，然后这个站所有的正常邮件都发不出去。」
 *
 * 所以这里不测规则，只测**接线**：给一个必然被拒的场景，
 * 看它到底有没有真的往外发。打桩 `fetch` —— 发信最终走的是 HTTPS，
 * 那是这条路上唯一一个「真的出去了」的证据。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-fwdwire-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";
// 没配发信的话 forwardMessage 第一行就返回了，什么都测不到
process.env.MAIL_SEND_PROVIDER = "resend";
process.env.MAIL_SEND_KEY = "test-key";
process.env.MAIL_SEND_FROM = "noreply@agenticlab.sh";

describe("转发闸门的接线", async () => {
  const dbm = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  const { forwardMessage } = await import("@/lib/mail/forward");

  after(() => {
    mock.restoreAll();
    rmSync(tmp, { recursive: true, force: true });
  });

  const USER = "u_fwd";
  const BOX = "box_fwd";

  /** 转发是 fire-and-forget 的，得给它一点时间跑完 */
  const settle = () => new Promise((r) => setTimeout(r, 60));

  /** 打桩 fetch —— 真的往外发才会走到这里 */
  const captureFetch = () => {
    const calls: string[] = [];
    mock.method(globalThis, "fetch", async (url: unknown) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ id: "sent" }), { status: 200 });
    });
    return calls;
  };

  const setup = (opts: { verified: boolean }) => {
    for (const t of [schema.mailEvents, schema.mailBoxes, schema.users]) dbm.db.delete(t).run();
    dbm.db
      .insert(schema.users)
      .values({
        id: USER,
        wxId: "wx_fwd",
        status: "active",
        pointsTotal: 100_000, // 等级那道闸不该是拦住它的原因
        email: "me@example.com",
        emailVerifiedAt: opts.verified ? Date.now() : null,
      })
      .run();
    dbm.db
      .insert(schema.mailBoxes)
      .values({
        id: BOX,
        userId: USER,
        address: "hi@hey.icu",
        localPart: "hi",
        domain: "hey.icu",
        kind: "burner",
        forwardEnabled: true,
        expiresAt: Date.now() + 86_400_000,
      })
      .run();
  };

  beforeEach(() => mock.restoreAll());

  it("★ 私人邮箱没验证过 → **一个字节都不能发出去**", async () => {
    setup({ verified: false });
    const calls = captureFetch();

    forwardMessage({ boxId: BOX, from: "a@b.com", fromName: null, subject: "嗨", bodyText: "正文" });
    await settle();

    assert.deepEqual(calls, [], "闸门说了不转，而信还是发出去了");

    const events = dbm.db.select().from(schema.mailEvents).all();
    assert.ok(
      events.some((e) => e.event === "forward_skipped"),
      "拦下来了却没留痕 —— 出问题时没有任何线索说明为什么没转",
    );
  });

  it("对照：验证过之后**确实会发**（否则上一条可能只是转发整个坏了）", async () => {
    /*
     * 没有这一条的话，「一个字节都没发出去」也可能是因为
     * 转发这条路整个是死的 —— 那样上一条测的就是个假的安心。
     */
    setup({ verified: true });
    const calls = captureFetch();

    forwardMessage({ boxId: BOX, from: "a@b.com", fromName: null, subject: "嗨", bodyText: "正文" });
    await settle();

    assert.equal(calls.length, 1, "验证过的地址也没转出去 —— 那这条路本来就是死的");
    assert.match(calls[0], /resend/, "发到了别的地方");
  });
});
