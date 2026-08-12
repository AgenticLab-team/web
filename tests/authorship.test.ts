import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { creditedWxId } from "@/lib/stats/authorship";

import { readCode } from "./_source";

/**
 * 发言算谁头上。
 *
 * ═════════════════════════════════════════
 * 这一条错了不会报错，只会让榜单慢慢变成假的
 * ═════════════════════════════════════════
 *
 * 线上量到的：机器人（群猫娘）在 daily_stats 里有 1598 条消息，
 * 按当时的算法它在总榜排第 6 —— 和真人同台竞争。
 * 而代发一旦跑通，每条代发消息都记在它头上，它只会越爬越高。
 */

const BOT = "wxid_bot";

describe("代发算给那个人，不算给机器人", () => {
  it("**代发优先于「机器人不算」** —— 顺序反了就把要救的那些丢掉了", () => {
    /*
     * 代发消息的 sender 就是机器人。先判机器人的话，它会被整条丢掉，
     * 而那正是我们要救回来的：他替群里发了三十条通知，
     * 一条都不该算在机器人头上，也一条都不该消失。
     */
    assert.equal(
      creditedWxId({ senderWxId: BOT, onBehalfOfWxId: "wxid_ming", botWxId: BOT }),
      "wxid_ming",
    );
  });

  it("机器人自己说的话不算任何人", () => {
    assert.equal(creditedWxId({ senderWxId: BOT, onBehalfOfWxId: null, botWxId: BOT }), null);
  });

  it("普通人照旧算他自己", () => {
    assert.equal(
      creditedWxId({ senderWxId: "wxid_ming", onBehalfOfWxId: null, botWxId: BOT }),
      "wxid_ming",
    );
  });

  it("**认不出机器人时什么都不排除** —— 宁可榜上多一个它", () => {
    /*
     * 上游不通、身份取不到时 botWxId 是 null。
     * 这时候猜一个的后果是把一个真人从榜上抹掉，
     * 比机器人在榜上多待一天严重得多。
     */
    assert.equal(creditedWxId({ senderWxId: BOT, onBehalfOfWxId: null, botWxId: null }), BOT);
  });

  it("代发给的名字是空串时按「没有代发」处理，不会算成空账号", () => {
    assert.equal(creditedWxId({ senderWxId: BOT, onBehalfOfWxId: "", botWxId: BOT }), null);
  });
});

describe("SQL 那一侧和纯函数说同一句话", () => {
  const sync = readCode("lib/sync/messages.ts");

  it("**重算用的是 credited，不是 sender_wx_id**", () => {
    /*
     * 采集那步用纯函数决定「重算哪些人 × 天」，重算那步用 SQL 决定
     * 「哪些消息算数」。两边一旦分叉，表现是**榜单数字对不上
     * 而没有任何地方报错** —— 这个仓库已经因为 daily_stats 和
     * messages 对不上吃过一次亏了。
     */
    assert.match(sync, /COALESCE\(u\.wx_id, m\.sender_wx_id\)/);
    // 老写法（直接按 sender 比）不该再出现在重算里
    assert.equal(
      /WHERE conv_id = \$\{convId\} AND sender_wx_id/.test(sync),
      false,
      "还有一处在直接按 sender 重算",
    );
  });

  it("代发只认**发成功**的那些", () => {
    // 失败的代发在表里也留着（限流要数），但群里根本没出现过那条消息
    assert.match(sync, /s\.ok = 1/);
  });

  it("**机器人那一条排除写在 COALESCE 外面**", () => {
    /*
     * 塞进 COALESCE 的话，代发消息会先被「机器人不算」判掉 ——
     * 和纯函数里那个顺序问题是同一个坑，只是换成了 SQL。
     */
    assert.match(sync, /NOT \(s\.id IS NULL AND m\.sender_wx_id/);
  });

  it("采集那步记的是 credited，不是 sender", () => {
    /*
     * 按 sender 记的话，代发消息只会让机器人那个桶被重算，
     * 而那个成员的桶永远不动 —— 于是他替群里发的通知一条都不算。
     */
    assert.match(sync, /touched\.add\(bucketKey\(credited/);
  });

  it("`is_send = 0` 那道过滤留着 —— 它现在什么都没挡住，但没有坏处", () => {
    /*
     * 线上实测全站 is_send=1 的行数是 0，上游返回的一律是 false。
     * 也就是说那道过滤一直在跑、一直什么都没挡住。
     * 留着是为了哪天上游开始正确填它 —— 两道闸一起生效。
     */
    assert.match(sync, /m\.is_send = 0/);
  });
});

describe("机器人身份取不到时不猜", () => {
  it("resolveBotWxId 失败返回缓存或 null，不抛", () => {
    const code = readCode("lib/stats/bot-identity.ts");
    assert.match(code, /catch/);
    assert.match(code, /cached\?\.wxId \?\? null/);
    // 不能写死一个 wx_id 兜底
    assert.equal(/wxid_[a-z0-9]{8,}/.test(code), false, "不该把某个 wx_id 写死在代码里");
  });
});
