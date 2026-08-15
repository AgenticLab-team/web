import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it, mock } from "node:test";

/**
 * 代发署名：**真正交给上游的那段文字**里有没有它。
 *
 * ═════════════════════════════════════════
 * 为什么原来那几条测试拦不住
 * ═════════════════════════════════════════
 *
 * 站长的原话是「网站不能带用户发这个消息」，后来放开成
 * 「按群单独授权可以发，但必须带上代发署名」。
 *
 * 现有的守卫有两层，而中间正好空着一格：
 *
 *   · `withAttribution()` 本身测得很足 —— 改它拼出来的那句话，
 *     十一条测试一起红
 *   · `api-surface.test.ts` 守着「路由只走 sendToGroup 这一条路」
 *
 * 但**没有人问过 `sendToGroup` 里那一句是不是真的调了它**。
 * `scripts/mutate.mjs` 把 `withAttribution(message.text, senderName)`
 * 换成 `message.text`，两层守卫都绿 —— 而站长那条红线当场就破了。
 *
 * 而 `send.ts` 里那句注释写的是：
 * 「**署名在这里拼**，而且这是全站唯一拼它的地方」。
 * 唯一的那个地方，恰恰是没被测到的那个地方。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-attr-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

describe("代发署名", async () => {
  const dbm = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  const client = await import("@/lib/nekobot/client");
  const { sendToGroup } = await import("@/lib/api-tokens/send");

  after(() => {
    mock.restoreAll();
    rmSync(tmp, { recursive: true, force: true });
  });

  const CONV = "g_attr@chatroom";
  const USER = { id: "u_send", wxId: "wx_send", siteNickname: "阿发", kind: "member" as const };

  beforeEach(() => {
    mock.restoreAll();
    for (const t of [
      schema.groupSendGrants,
      schema.groupMembers,
      schema.groups,
      schema.users,
      schema.apiSends,
    ]) {
      dbm.db.delete(t).run();
    }

    dbm.db
      .insert(schema.users)
      .values({ id: USER.id, wxId: USER.wxId, siteNickname: USER.siteNickname, status: "active" })
      .run();
    dbm.db
      .insert(schema.groups)
      .values({ convId: CONV, name: "测试群", isGroup: true, bound: true, syncEnabled: true })
      .run();
    dbm.db
      .insert(schema.groupMembers)
      .values({ convId: CONV, wxId: USER.wxId, displayName: "阿发", joinedAt: Date.now() })
      .run();
    dbm.db
      .insert(schema.groupSendGrants)
      .values({
        convId: CONV,
        userId: USER.id,
        grantedBy: "u_owner",
        reason: "测试授权",
        perMinute: 10,
        perHour: 100,
        perDay: 1000,
      })
      .run();
  });

  /** 打桩上游，把真正发出去的那段文字抓下来 */
  const captureSend = () => {
    const sent: string[] = [];
    mock.method(client.nekobot, "sendText", async (_convId: string, text: string) => {
      sent.push(text);
      return { msg_svr_id: "m1" };
    });
    return sent;
  };

  it("★ 发出去的正文末尾必须带上署名，而且写着是谁", async () => {
    const sent = captureSend();
    const r = await sendToGroup({
      user: USER as never,
      tokenId: null,
      convId: CONV,
      text: "大家好",
    });

    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal(sent.length, 1, "没有真的发出去");
    assert.ok(sent[0].startsWith("大家好"), "正文被改掉了");
    assert.match(sent[0], /代发/, "发出去的消息里没有代发署名 —— 站长那条红线");
    assert.match(sent[0], /阿发/, "署名里没写是谁发的");
  });

  it("★ 留痕里存的和发出去的是同一段文字", async () => {
    const sent = captureSend();
    await sendToGroup({ user: USER as never, tokenId: null, convId: CONV, text: "留个痕" });

    const rows = dbm.db.select().from(schema.apiSends).all();
    assert.equal(rows.length, 1, "没留痕");
    assert.equal(rows[0].text, sent[0], "留痕里存的和真正发出去的不是同一段");
  });
});
