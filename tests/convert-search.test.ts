import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * 「整理成帖子」的关键词搜索。
 *
 * ─────────────────────────────────────────
 * 「按天翻」这条路要求人先知道是哪天
 * ─────────────────────────────────────────
 *
 * 原来这一页只能选群 + 选日期。而人想整理的东西通常是
 * 「上个月有人讲过怎么做那个部署」—— 他记得内容，不记得日期。
 * 只能一天天翻，而群聊一天几百条，翻三天就放弃了。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-convert-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

let dbm: typeof import("@/lib/db");
let schema: typeof import("@/lib/db/schema");
let source: typeof import("@/lib/forum/convert-source");

const CONV_MINE = "mine@chatroom";
const CONV_THEIRS = "theirs@chatroom";
const ME = "01USERME00000000000000000";
const MY_WX = "wxid_me";

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  source = await import("@/lib/forum/convert-source");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

let seq = 0;
function addMessage(convId: string, content: string, ts: number) {
  const id = `m${seq++}`;
  dbm.db
    .insert(schema.messages)
    .values({ id, convId, senderWxId: MY_WX, senderName: "我", ts, type: "text", content })
    .run();
  /*
   * 按**生产同样的方式**写索引：msg_id / conv_id / sender_wx_id / content。
   *
   * 一开始这里写的是 `INSERT INTO messages_fts(rowid, content)`，
   * 于是测试恰好「配合」了实现里那个按 rowid 连表的 bug ——
   * 测试全绿，而生产上搜「台风」返回的 22 条里一条台风都没有。
   * fixture 和生产不同构的测试，验的是它自己。
   */
  dbm.sqlite
    .prepare("INSERT INTO messages_fts(msg_id, conv_id, sender_wx_id, content) VALUES (?, ?, ?, ?)")
    .run(id, convId, MY_WX, segment(content));
  return id;
}

/** 和 lib/db/fts.ts 的 segmentForIndex 同一套：中日韩逐字加空格 */
function segment(text: string): string {
  return text.replace(/[一-鿿぀-ヿ가-힯]/g, (c) => `${c} `);
}

beforeEach(() => {
  for (const t of [schema.messages, schema.groupMembers, schema.groups, schema.users]) {
    dbm.db.delete(t).run();
  }
  dbm.sqlite.prepare("DELETE FROM messages_fts").run();
  seq = 0;

  dbm.db
    .insert(schema.groups)
    .values([
      { convId: CONV_MINE, name: "我在的群", syncEnabled: true },
      { convId: CONV_THEIRS, name: "我不在的群", syncEnabled: true },
    ])
    .run();
  dbm.db
    .insert(schema.users)
    .values({ id: ME, wxId: MY_WX, wxNickname: "我", status: "active" })
    .run();
  dbm.db.insert(schema.groupMembers).values({ convId: CONV_MINE, wxId: MY_WX, messages: 5 }).run();
});

const me = () => dbm.db.select().from(schema.users).all()[0];

describe("按关键词找消息", () => {
  it("找得到", () => {
    addMessage(CONV_MINE, "那个部署脚本我改好了", 3000);
    addMessage(CONV_MINE, "今天天气不错", 4000);

    const r = source.searchMessagesForConvert(me(), CONV_MINE, "部署");
    assert.ok(r);
    assert.equal(r!.rows.length, 1);
    assert.match(r!.rows[0].content, /部署脚本/);
  });

  it("**结果按时间正序** —— 倒过来的对话读起来是乱的", () => {
    /*
     * 检索本身是倒序找出来的，但整理成帖子时要的是对话的顺序。
     * 人多半不会意识到是顺序问题，只会觉得「整理出来的东西看不懂」。
     */
    addMessage(CONV_MINE, "部署第一句", 1000);
    addMessage(CONV_MINE, "部署第二句", 2000);
    addMessage(CONV_MINE, "部署第三句", 3000);

    const r = source.searchMessagesForConvert(me(), CONV_MINE, "部署");
    assert.deepEqual(
      r!.rows.map((x) => x.ts),
      [1000, 2000, 3000],
    );
  });

  it("**权限和按天那条路一样收口** —— 搜不到自己不在的群", () => {
    addMessage(CONV_THEIRS, "别的群的部署", 1000);
    assert.equal(source.searchMessagesForConvert(me(), CONV_THEIRS, "部署"), null);
  });

  it("未登录一律拿不到", () => {
    addMessage(CONV_MINE, "部署", 1000);
    assert.equal(source.searchMessagesForConvert(null, CONV_MINE, "部署"), null);
  });

  it("搜别的群的词，不会串到自己群里", () => {
    addMessage(CONV_THEIRS, "只有那个群聊过的暗号", 1000);
    const r = source.searchMessagesForConvert(me(), CONV_MINE, "暗号");
    assert.deepEqual(r!.rows, []);
  });

  it("**只打标点的搜索返回空，不是返回全部**", () => {
    /*
     * 返回全部的话，一个手滑的搜索会显示成「这个群有 3 万条消息」。
     */
    addMessage(CONV_MINE, "随便什么", 1000);
    for (const junk of ["", "   ", '"', "()", "*"]) {
      const r = source.searchMessagesForConvert(me(), CONV_MINE, junk);
      assert.deepEqual(r!.rows, [], `「${junk}」返回了内容`);
    }
  });

  it("**带 FTS 语法字符的输入不会炸，也不会静默失效**", () => {
    /*
     * FTS5 的转义写错不报错，只会永远匹配不到任何东西 ——
     * 所以这条路必须复用 lib/db/fts.ts，不能另写一份。
     *
     * 注意 `鉴权"OR"1` 被清成三个词（鉴权 / OR / 1）且**默认是 AND**，
     * 所以搜不到是对的 —— 那条消息里没有 OR 也没有 1。
     * 这里要证的是「不抛异常、而且去掉噪音之后仍然能搜到」。
     */
    addMessage(CONV_MINE, "鉴权那块改完了", 1000);

    assert.doesNotThrow(() => source.searchMessagesForConvert(me(), CONV_MINE, '鉴权"OR"1'));
    assert.doesNotThrow(() => source.searchMessagesForConvert(me(), CONV_MINE, "鉴权*(:^-"));

    // 语法字符被剥掉之后，剩下的真词照样命中
    const r = source.searchMessagesForConvert(me(), CONV_MINE, '鉴权"');
    assert.equal(r!.rows.length, 1, "引号把一个正常的词搞失效了");
  });

  it("多个词是 AND —— 两个词都出现才算命中", () => {
    addMessage(CONV_MINE, "鉴权那块改完了", 1000);
    addMessage(CONV_MINE, "部署那块改完了", 2000);

    assert.equal(source.searchMessagesForConvert(me(), CONV_MINE, "鉴权 改完")!.rows.length, 1);
    assert.equal(source.searchMessagesForConvert(me(), CONV_MINE, "鉴权 部署")!.rows.length, 0);
  });

  it("正文被裁剪掉的不进列表 —— 空气泡比缺一条更让人困惑", () => {
    addMessage(CONV_MINE, "部署说明", 1000);
    dbm.db.update(schema.messages).set({ content: "" }).run();
    const r = source.searchMessagesForConvert(me(), CONV_MINE, "部署");
    assert.deepEqual(r!.rows, []);
  });

  it("带上发送人名字和头像 —— 挑选界面要用", () => {
    dbm.db
      .insert(schema.people)
      .values({ wxId: MY_WX, displayName: "张三", avatarUrl: "https://x/a.png" })
      .run();
    addMessage(CONV_MINE, "部署好了", 1000);

    const r = source.searchMessagesForConvert(me(), CONV_MINE, "部署");
    assert.equal(r!.rows[0].senderName, "张三");
    assert.equal(r!.rows[0].avatarUrl, "https://x/a.png");
  });
});

describe("**两条路返回同一种结构**", () => {
  it("搜索和按天返回的字段一样 —— 挑选界面才不用改", () => {
    addMessage(CONV_MINE, "部署好了", Date.UTC(2026, 7, 9, 4));

    const byDay = source.messagesOfDay(me(), CONV_MINE, "2026-08-09");
    const bySearch = source.searchMessagesForConvert(me(), CONV_MINE, "部署");
    assert.ok(byDay && bySearch);
    if (!byDay!.rows.length || !bySearch!.rows.length) return;
    assert.deepEqual(Object.keys(byDay!.rows[0]).sort(), Object.keys(bySearch!.rows[0]).sort());
  });
});

describe("界面", () => {
  const page = src("app/(app)/forum/convert/page.tsx");

  it("**复用检索页那套搜索框**，不另起一份", () => {
    assert.match(page, /searchMessagesForConvert/);
    assert.match(page, /name="q"/);
    assert.match(page, /SearchIcon/);
  });

  it("搜索态下不显示翻天的控件 —— 两套导航同时在会让人不确定自己在看什么", () => {
    assert.match(page, /query \? "hidden" : ""/);
  });

  it("**切群时把搜索词带上** —— 丢掉的话人得重新打一遍", () => {
    assert.match(page, /query \? `&q=\$\{encodeURIComponent\(query\)\}`/);
  });

  it("给一条回到按天翻的路", () => {
    assert.match(page, /回到按天翻/);
  });

  it("搜不到时的空态说的是搜索，不是「这天没消息」", () => {
    assert.match(page, /在这个群里没搜到/);
  });

  it("结果被截断时要说出来 —— 不说的话人以为就这么多", () => {
    assert.match(page, /只显示最近 120 条/);
  });
});

describe("规则复用", () => {
  it("搜索走 lib/db/fts.ts 的表达式构造，不自己拼 MATCH", () => {
    const code = src("lib/forum/convert-source.ts");
    assert.match(code, /buildMatchExpression\(/);
    // 不能自己拼引号 —— FTS5 转义写错不报错，只会永远匹配不到
    const fn = code.slice(code.indexOf("function searchMessagesForConvert"));
    assert.doesNotMatch(fn, /'"' \+|`"\$\{/);
  });

  it("权限走同一个 assertGroupAccess", () => {
    const code = src("lib/forum/convert-source.ts");
    const fn = code.slice(code.indexOf("function searchMessagesForConvert"));
    assert.match(fn.slice(0, 400), /assertGroupAccess\(user, convId\)/);
  });
});
