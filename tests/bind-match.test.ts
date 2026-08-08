import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * 验证码归属判定。
 *
 * 2026-08 起群消息成为**主通道**（机器人加好友触发了微信风控），
 * 而群里的验证码是所有人都看得见的 —— 归属判错的后果不是登录失败，
 * 是**别人拿到你的会话**。所以这两条规则按安全问题对待：
 *   1. 先发的人赢
 *   2. 群消息必须带前缀词
 */

const tmp = mkdtempSync(join(tmpdir(), "al-bind-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

type BindModule = typeof import("@/lib/auth/bind");
type UpstreamMessage = Parameters<BindModule["resolveMessageMatches"]>[0][number];

let bind: BindModule;

const PREFIX = "登录";
const GROUP = "12345@chatroom";
const DM = "wxid_bot";

before(async () => {
  const dbm = await import("@/lib/db");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  bind = await import("@/lib/auth/bind");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

function msg(overrides: {
  content: string;
  sender: string;
  at: number;
  conv?: string;
  type?: string;
}): UpstreamMessage {
  return {
    msg_svr_id: `m_${overrides.sender}_${overrides.at}`,
    conv_id: overrides.conv ?? GROUP,
    conv_name: "测试群",
    sender_wx_id: overrides.sender,
    sender_name: `昵称-${overrides.sender}`,
    is_send: false,
    type: (overrides.type ?? "text") as UpstreamMessage["type"],
    content: overrides.content,
    length: overrides.content.length,
    create_time: overrides.at,
    time: String(overrides.at),
  };
}

describe("先发的人赢", () => {
  it("**同一个码被两个人先后发出，归先发的那个**", () => {
    // 群里的码是公开的：看到之后原样再发一遍就想抢会话 —— 必须抢不到
    const items = [
      msg({ content: "登录 123456", sender: "wx_attacker", at: 2000 }),
      msg({ content: "登录 123456", sender: "wx_victim", at: 1000 }),
    ];

    const winners = bind.resolveMessageMatches(items, ["123456"], PREFIX);
    assert.equal(winners.get("123456")!.senderWxId, "wx_victim");
  });

  it("上游按倒序返回也不影响结论", () => {
    // 上游是 order:"desc"，照原顺序遍历就会变成「后发的人赢」
    const desc = [
      msg({ content: "登录 123456", sender: "wx_late", at: 9000 }),
      msg({ content: "登录 123456", sender: "wx_early", at: 100 }),
    ];
    const asc = [...desc].reverse();

    assert.equal(
      bind.resolveMessageMatches(desc, ["123456"], PREFIX).get("123456")!.senderWxId,
      bind.resolveMessageMatches(asc, ["123456"], PREFIX).get("123456")!.senderWxId,
    );
    assert.equal(
      bind.resolveMessageMatches(desc, ["123456"], PREFIX).get("123456")!.senderWxId,
      "wx_early",
    );
  });
});

describe("群消息必须带前缀", () => {
  it("带前缀的认", () => {
    const winners = bind.resolveMessageMatches(
      [msg({ content: "登录 123456", sender: "wx_a", at: 1 })],
      ["123456"],
      PREFIX,
    );
    assert.equal(winners.size, 1);
  });

  it("**裸数字不认**", () => {
    // 群里任何一串六位数字（电话尾号、金额、日期）都可能撞上某个待验证码
    const winners = bind.resolveMessageMatches(
      [msg({ content: "123456", sender: "wx_a", at: 1 })],
      ["123456"],
      PREFIX,
    );
    assert.equal(winners.size, 0);
  });

  it("聊天里偶然出现的六位数字不会误绑", () => {
    const winners = bind.resolveMessageMatches(
      [msg({ content: "我这单花了 123456 块", sender: "wx_a", at: 1 })],
      ["123456"],
      PREFIX,
    );
    assert.equal(winners.size, 0);
  });

  it("**私聊不需要前缀** —— 一对一没有代发问题", () => {
    const winners = bind.resolveMessageMatches(
      [msg({ content: "123456", sender: "wx_a", at: 1, conv: DM })],
      ["123456"],
      PREFIX,
    );
    assert.equal(winners.size, 1);
    assert.equal(winners.get("123456")!.isGroup, false);
  });

  it("正确区分群与私聊", () => {
    const group = bind.resolveMessageMatches(
      [msg({ content: "登录 123456", sender: "wx_a", at: 1 })],
      ["123456"],
      PREFIX,
    );
    assert.equal(group.get("123456")!.isGroup, true);
    assert.equal(group.get("123456")!.convId, GROUP);
  });
});

describe("多个码同时待验证", () => {
  it("各自归各自的发送者", () => {
    const items = [
      msg({ content: "登录 111111", sender: "wx_a", at: 10 }),
      msg({ content: "登录 222222", sender: "wx_b", at: 20 }),
    ];
    const winners = bind.resolveMessageMatches(items, ["111111", "222222"], PREFIX);
    assert.equal(winners.get("111111")!.senderWxId, "wx_a");
    assert.equal(winners.get("222222")!.senderWxId, "wx_b");
  });

  it("**一条消息最多认领一个码**", () => {
    // 一条消息里塞进多个待验证码，正常人不会这么发，
    // 只可能是有人在试图一次抢走一批会话
    const items = [msg({ content: "登录 111111 222222", sender: "wx_greedy", at: 10 })];
    const winners = bind.resolveMessageMatches(items, ["111111", "222222"], PREFIX);
    assert.equal(winners.size, 1);
  });

  it("没有待验证码时不做任何匹配", () => {
    const items = [msg({ content: "登录 123456", sender: "wx_a", at: 1 })];
    assert.equal(bind.resolveMessageMatches(items, [], PREFIX).size, 0);
  });
});

describe("非文本消息", () => {
  it("图片、语音之类一律跳过", () => {
    const items = [
      msg({ content: "登录 123456", sender: "wx_a", at: 1, type: "image" }),
      msg({ content: "登录 123456", sender: "wx_b", at: 2 }),
    ];
    const winners = bind.resolveMessageMatches(items, ["123456"], PREFIX);
    assert.equal(winners.get("123456")!.senderWxId, "wx_b");
  });
});

describe("原文留证", () => {
  it("保留消息原文与时间 —— 绑定纠纷时这是唯一证据", () => {
    const items = [msg({ content: "登录 123456 我来啦", sender: "wx_a", at: 4242 })];
    const match = bind.resolveMessageMatches(items, ["123456"], PREFIX).get("123456")!;
    assert.equal(match.content, "登录 123456 我来啦");
    assert.equal(match.createTime, 4242);
    assert.equal(match.senderName, "昵称-wx_a");
  });
});
