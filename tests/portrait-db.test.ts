import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * 主页上的「这个人是什么样的」—— 接上真库之后。
 *
 * ═════════════════════════════════════════
 * 这里守的全部是边界，不是算法
 * ═════════════════════════════════════════
 *
 * 算法（挑哪个词）在 catchphrase.test.ts 里离线测得很密。
 * 这个文件只问两件事，而这两件事错了都不会有任何地方报错：
 *
 *   ① **只用共同群的数据。** 用了别的群，等于把那个群的存在
 *      连同他在那里的说话习惯一起透给你。
 *   ② **隐私开关真的接上了。** 「他最爱说 X」是一句结论，
 *      而结论是翻聊天记录翻不出来的 —— 聚合出来的画像
 *      比原始内容更进一步（雷达那次的教训）。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-portrait-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

let dbm: typeof import("@/lib/db");
let schema: typeof import("@/lib/db/schema");
let phrases: typeof import("@/lib/members/phrases");

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  phrases = await import("@/lib/members/phrases");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  for (const t of [
    schema.personPhrases,
    schema.messageMentions,
    schema.messages,
    schema.people,
    schema.groups,
    schema.userPrivacy,
    schema.users,
  ]) {
    dbm.db.delete(t).run();
  }
});

let seq = 0;

function addGroup(convId: string) {
  dbm.db
    .insert(schema.groups)
    .values({ convId, name: `群 ${convId}`, syncEnabled: true })
    .run();
}

function say(convId: string, wxId: string, text: string, day: number) {
  const id = `m_${++seq}`;
  dbm.db
    .insert(schema.messages)
    .values({
      id,
      convId,
      senderWxId: wxId,
      senderName: wxId,
      type: "text",
      content: text,
      // 每条一天，横跨天数那道闸才过得去
      ts: Date.UTC(2026, 0, (day % 27) + 1, 12),
    })
    .run();
  return id;
}

/** 让某人在某群里有一个明显的口头禅 */
function seedCatchphrase(convId: string, wxId: string, phrase: string) {
  for (let i = 0; i < 40; i++) say(convId, wxId, phrase, i);
  // 同群其他人说别的，当基准
  for (let i = 0; i < 200; i++) say(convId, "other", `闲聊${i}${"零一二三四五六七八九"[i % 10]}`, i);
}

function mention(convId: string, from: string, to: string, day: number) {
  const messageId = say(convId, from, `叫一下`, day);
  dbm.db
    .insert(schema.messageMentions)
    .values({
      id: `mm_${++seq}`,
      messageId,
      convId,
      ts: Date.UTC(2026, 0, (day % 27) + 1, 12),
      name: to,
      status: "resolved",
      wxId: to,
      position: 0,
    })
    .run();
}

function addUser(id: string, wxId: string, searchable = true) {
  dbm.db.insert(schema.users).values({ id, wxId, status: "active" }).run();
  dbm.db
    .insert(schema.userPrivacy)
    .values({ userId: id, searchableByOthers: searchable })
    .run();
}

const viewer = (wxId: string | null) =>
  (wxId === null ? null : { id: `u_${wxId}`, wxId }) as never;

describe("常挂在嘴边", () => {
  it("算得出来，读得回来", () => {
    addGroup("g1");
    seedCatchphrase("g1", "alice", "卧槽");

    const r = phrases.computePersonPhrases({ force: true });
    assert.ok(r.written >= 1, "一个都没算出来");

    const got = phrases.catchphraseFor(viewer("bob"), "alice", ["g1"]);
    assert.equal(got?.phrase, "卧槽");
    assert.ok(got!.hits >= 40);
  });

  it("**只看传进来的那几个群** —— 共同群之外的一律不算", () => {
    /*
     * 这是整块功能的隐私底线。拿到别的群的结果，等于把那个群的存在
     * 连同他在那里的说话习惯一起透给了一个不在那个群的人。
     */
    addGroup("g1");
    addGroup("g2");
    seedCatchphrase("g2", "alice", "卧槽");
    phrases.computePersonPhrases({ force: true });

    assert.equal(phrases.catchphraseFor(viewer("bob"), "alice", ["g1"]), null);
    assert.ok(phrases.catchphraseFor(viewer("bob"), "alice", ["g2"]));
  });

  it("一个共同群都没有时返回 null，不去查库", () => {
    assert.equal(phrases.catchphraseFor(viewer("bob"), "alice", []), null);
  });

  it("说得不够多的人没有", () => {
    addGroup("g1");
    for (let i = 0; i < 10; i++) say("g1", "alice", "卧槽", i);
    phrases.computePersonPhrases({ force: true });
    assert.equal(phrases.catchphraseFor(viewer("bob"), "alice", ["g1"]), null);
  });

  it("**这一轮算不出来时，要把上一轮的删掉**", () => {
    /*
     * 不删的话，一个人改了说话习惯（或者那个词被加进了名册）之后，
     * 主页上会一直挂着一句**再也不会被重算的**旧结论 ——
     * 而它看起来和新算出来的一模一样。
     */
    addGroup("g1");
    seedCatchphrase("g1", "alice", "卧槽");
    phrases.computePersonPhrases({ force: true });
    assert.ok(phrases.catchphraseFor(viewer("bob"), "alice", ["g1"]));

    // 把那些消息删掉再算一轮
    dbm.db.delete(schema.messages).run();
    for (let i = 0; i < 40; i++) say("g1", "alice", `随便说${i}${"零一二三四五六七八九"[i % 10]}`, i);
    phrases.computePersonPhrases({ force: true });
    assert.equal(phrases.catchphraseFor(viewer("bob"), "alice", ["g1"]), null, "旧结论还挂着");
  });
});

describe("**隐私开关：第六个出口**", () => {
  it("关掉「别人能搜到我的发言」之后，别人看不到这一栏", () => {
    addGroup("g1");
    addUser("u_alice", "alice", false);
    seedCatchphrase("g1", "alice", "卧槽");
    phrases.computePersonPhrases({ force: true });

    assert.equal(phrases.catchphraseFor(viewer("bob"), "alice", ["g1"]), null);
  });

  it("**他自己看自己照常看得到** —— 藏的是别人的视角", () => {
    addGroup("g1");
    addUser("u_alice", "alice", false);
    seedCatchphrase("g1", "alice", "卧槽");
    phrases.computePersonPhrases({ force: true });

    assert.ok(phrases.catchphraseFor(viewer("alice"), "alice", ["g1"]));
  });

  it("没关的人照常显示", () => {
    addGroup("g1");
    addUser("u_alice", "alice", true);
    seedCatchphrase("g1", "alice", "卧槽");
    phrases.computePersonPhrases({ force: true });
    assert.ok(phrases.catchphraseFor(viewer("bob"), "alice", ["g1"]));
  });
});

describe("@ 得最多", () => {
  it("双向合计 —— 他 @ 别人和别人 @ 他都算", () => {
    /*
     * 只数一个方向的话，一个从不 @ 人、但被所有人 @ 的人
     * 会显示成「没有」。@ 本来就是一来一回的事。
     */
    addGroup("g1");
    for (let i = 0; i < 3; i++) mention("g1", "alice", "bob", i);
    for (let i = 0; i < 4; i++) mention("g1", "bob", "alice", i);

    const got = phrases.topMentionPartner(viewer("carol"), "alice", ["g1"]);
    assert.equal(got?.wxId, "bob");
    assert.equal(got?.count, 7);
  });

  it("**次数不够不显示** —— 一两次不叫「最多」", () => {
    addGroup("g1");
    mention("g1", "alice", "bob", 1);
    assert.equal(phrases.topMentionPartner(viewer("carol"), "alice", ["g1"]), null);
  });

  it("**自己 @ 自己不算**", () => {
    addGroup("g1");
    for (let i = 0; i < 9; i++) mention("g1", "alice", "alice", i);
    assert.equal(phrases.topMentionPartner(viewer("carol"), "alice", ["g1"]), null);
  });

  it("**只数共同群里的** —— 和口头禅同一条边界", () => {
    addGroup("g1");
    addGroup("g2");
    for (let i = 0; i < 9; i++) mention("g2", "alice", "bob", i);
    assert.equal(phrases.topMentionPartner(viewer("carol"), "alice", ["g1"]), null);
    assert.ok(phrases.topMentionPartner(viewer("carol"), "alice", ["g2"]));
  });

  it("解析不出是谁的 @ 不算 —— ambiguous / unknown 都不能凑数", () => {
    addGroup("g1");
    for (const status of ["ambiguous", "unknown", "all"] as const) {
      for (let i = 0; i < 4; i++) {
        // 每条 @ 挂在自己的消息上：同一条消息里 position 不能重复
        const id = say("g1", "alice", "叫一下", i);
        dbm.db
          .insert(schema.messageMentions)
          .values({
            id: `mm_x_${++seq}`,
            messageId: id,
            convId: "g1",
            ts: 1,
            name: "谁",
            status,
            wxId: null,
            position: 0,
          })
          .run();
      }
    }
    assert.equal(phrases.topMentionPartner(viewer("carol"), "alice", ["g1"]), null);
  });

  it("**被点名的那一方也要过隐私开关**", () => {
    /*
     * 很容易漏：想着「这是 alice 的主页，管 alice 的开关就行」——
     * 而这句结论里有两个人。bob 关掉了开关，就不该因为
     * **别人的**主页而被点名。
     */
    addGroup("g1");
    addUser("u_bob", "bob", false);
    for (let i = 0; i < 9; i++) mention("g1", "alice", "bob", i);
    assert.equal(phrases.topMentionPartner(viewer("carol"), "alice", ["g1"]), null);
  });

  it("主人公自己关掉了，也不显示", () => {
    addGroup("g1");
    addUser("u_alice", "alice", false);
    for (let i = 0; i < 9; i++) mention("g1", "alice", "bob", i);
    assert.equal(phrases.topMentionPartner(viewer("carol"), "alice", ["g1"]), null);
  });
});

describe("接线", () => {
  const read = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

  it("**主页真的渲染了这一块**", () => {
    const page = read("app/(app)/members/[wxId]/page.tsx");
    assert.match(page, /catchphraseFor\(user, wxId, convIds\)/);
    assert.match(page, /topMentionPartner\(user, wxId, convIds\)/);
    assert.match(page, /<Portrait/);
  });

  it("**传的是共同群** —— 不是全站的群", () => {
    const page = read("app/(app)/members/[wxId]/page.tsx");
    assert.match(page, /const convIds = profile\.sharedGroups\.map/);
  });

  it("**称号摆上主页了**，而且只摆还生效的", () => {
    const page = read("app/(app)/members/[wxId]/page.tsx");
    assert.match(page, /titlesOf\(account\.id\)\.filter\(\(t\) => t\.active\)/);
    assert.match(page, /<TitleRow/);
  });

  it("**定时任务会重算** —— 不然算出来那一次之后就永远不动了", () => {
    const health = readFileSync(new URL("../scripts/health.ts", import.meta.url), "utf8");
    assert.match(health, /computePersonPhrases\(\)/);
  });
});

describe("**节流：别每 5 分钟烧 36 秒 CPU**", () => {
  it("刚算过就跳过", () => {
    /*
     * 线上实测一轮 36 秒（11 个群、206 人）。而它挂在
     * **每 5 分钟一次**的健康检查上 —— 不节流就是一直烧。
     *
     * 单看那一步是对的，单看那个定时器也是对的，错的是两者的组合；
     * 这种错没有任何一处会报警。
     */
    addGroup("g1");
    seedCatchphrase("g1", "alice", "卧槽");
    assert.equal(phrases.computePersonPhrases({ force: true }).skipped, false);

    const again = phrases.computePersonPhrases();
    assert.equal(again.skipped, true, "又重算了一遍");
    assert.equal(again.written, 0);
  });

  it("**跳过时不许把已有的结果删掉**", () => {
    /*
     * 「算不出来就删掉上一轮的」那条规则如果在跳过的路径上也跑，
     * 每 5 分钟就会把整张表清空一次 —— 而页面上的表现是
     * 「这一栏时有时无」，最难查的那种。
     */
    addGroup("g1");
    seedCatchphrase("g1", "alice", "卧槽");
    phrases.computePersonPhrases({ force: true });
    phrases.computePersonPhrases();
    assert.ok(phrases.catchphraseFor(viewer("bob"), "alice", ["g1"]), "结果被跳过那一轮清掉了");
  });

  it("force 时照算不误 —— 手动重跑要能立刻见效", () => {
    addGroup("g1");
    seedCatchphrase("g1", "alice", "卧槽");
    phrases.computePersonPhrases({ force: true });
    assert.equal(phrases.computePersonPhrases({ force: true }).skipped, false);
  });

  it("从来没算过时不跳过", () => {
    addGroup("g1");
    seedCatchphrase("g1", "alice", "卧槽");
    assert.equal(phrases.computePersonPhrases().skipped, false);
  });
});

describe("**最常用的表情**", () => {
  it("算得出来", () => {
    addGroup("g1");
    for (let i = 0; i < 40; i++) say("g1", "alice", `随便说${i}${"零一二三四五六七八九"[i % 10]}[旺柴]`, i);
    phrases.computePersonPhrases({ force: true });

    const got = phrases.topEmojiFor(viewer("bob"), "alice", ["g1"]);
    assert.equal(got?.emoji, "旺柴");
    assert.equal(got?.hits, 40);
  });

  it("**不会同时变成口头禅** —— 那不是他说的话", () => {
    /*
     * 线上第一版 112 个人里有四个的「口头禅」是「旺柴」。
     * 「他常把旺柴挂在嘴边、说过 52 次」是一句错的话。
     */
    addGroup("g1");
    for (let i = 0; i < 40; i++) say("g1", "alice", `[旺柴]`, i);
    for (let i = 0; i < 200; i++) say("g1", "other", `闲聊${i}${"零一二三四五六七八九"[i % 10]}`, i);
    phrases.computePersonPhrases({ force: true });

    assert.equal(phrases.catchphraseFor(viewer("bob"), "alice", ["g1"]), null);
    assert.equal(phrases.topEmojiFor(viewer("bob"), "alice", ["g1"])?.emoji, "旺柴");
  });

  it("**`[图片]` 这种占位符不算表情** —— 那是消息类型，不是他挑的", () => {
    /*
     * 上游不给媒体地址，图片消息的正文就是「[图片]」三个字。
     * 不排掉的话，发图多的人「最常用的表情」会是「图片」。
     */
    addGroup("g1");
    for (let i = 0; i < 40; i++) say("g1", "alice", "[图片]", i);
    phrases.computePersonPhrases({ force: true });
    assert.equal(phrases.topEmojiFor(viewer("bob"), "alice", ["g1"]), null);
  });

  it("点得太少不算", () => {
    addGroup("g1");
    for (let i = 0; i < 40; i++) say("g1", "alice", i < 3 ? "[旺柴]" : `闲${i}${"零一二三四五六七八九"[i % 10]}`, i);
    phrases.computePersonPhrases({ force: true });
    assert.equal(phrases.topEmojiFor(viewer("bob"), "alice", ["g1"]), null);
  });

  it("**只有表情没有口头禅时，那一行照样出得来**", () => {
    /*
     * 两样分开取。合在一个判断里的话，一个只有表情的人
     * 会因为「没有口头禅」而连表情一起消失。
     */
    addGroup("g1");
    for (let i = 0; i < 40; i++) say("g1", "alice", `闲聊${i}${"零一二三四五六七八九"[i % 10]}[捂脸]`, i);
    phrases.computePersonPhrases({ force: true });
    assert.equal(phrases.catchphraseFor(viewer("bob"), "alice", ["g1"]), null);
    assert.ok(phrases.topEmojiFor(viewer("bob"), "alice", ["g1"]));
  });

  it("**同样过隐私开关和共同群两道闸**", () => {
    addGroup("g1");
    addGroup("g2");
    addUser("u_alice", "alice", false);
    for (let i = 0; i < 40; i++) say("g1", "alice", `闲聊${i}${"零一二三四五六七八九"[i % 10]}[旺柴]`, i);
    phrases.computePersonPhrases({ force: true });

    assert.equal(phrases.topEmojiFor(viewer("bob"), "alice", ["g1"]), null, "隐私开关没接上");
    assert.equal(phrases.topEmojiFor(viewer("alice"), "alice", ["g2"]), null, "共同群没收口");
    assert.ok(phrases.topEmojiFor(viewer("alice"), "alice", ["g1"]), "他自己该看得到");
  });
});

describe("**两份隐私名单一次取完，语义一个字都不能变**", () => {
  /*
   * 合并只是为了少问一遍「这个人有没有豁免权」（那次判定本身要跑两条
   * 查询，而成员目录两份名单都要）。**合并最容易出的错是顺手改了语义**
   * —— 比如漏掉「自己永远看得见自己」，或者把两个开关的方向搞反。
   * 那种错不会有任何地方报警，只会让一批人被重新暴露出去。
   */
  let privacy: typeof import("@/lib/privacy/queries");

  before(async () => {
    privacy = await import("@/lib/privacy/queries");
  });

  const setup = () => {
    addUser("u_a", "wx_a", true);
    addUser("u_b", "wx_b", false);
    dbm.db.insert(schema.users).values({ id: "u_c", wxId: "wx_c", status: "active" }).run();
    dbm.db
      .insert(schema.userPrivacy)
      .values({ userId: "u_c", searchableByOthers: true, hideFromLeaderboard: true })
      .run();
  };

  it("和分开取的结果一模一样", () => {
    setup();
    const v = viewer("wx_a");
    const both = privacy.hiddenWxIds(v);
    assert.deepEqual(both.unsearchable.sort(), privacy.unsearchableWxIds(v).sort());
    assert.deepEqual(both.leaderboard.sort(), privacy.leaderboardHiddenWxIds(v).sort());
  });

  it("两个开关不会串", () => {
    setup();
    const got = privacy.hiddenWxIds(viewer("wx_a"));
    assert.deepEqual(got.unsearchable, ["wx_b"], "关搜索的那个跑到榜单名单里了");
    assert.deepEqual(got.leaderboard, ["wx_c"], "关榜单的那个跑到搜索名单里了");
  });

  it("**自己永远不在名单里** —— 他自己看自己照常看得到", () => {
    setup();
    const got = privacy.hiddenWxIds(viewer("wx_b"));
    assert.equal(got.unsearchable.includes("wx_b"), false);
  });

  it("**管理员只在检索那一份上有豁免**，榜单那份对他一样藏", () => {
    /*
     * 豁免是**逐条**给的（`PRIVACY_SWITCHES[].adminBypass`）。
     * 检索那条给了，理由是不给的话举报处理不了；
     * 榜单那条没给 —— 没有一件审核工作需要知道藏起来的人排第几。
     *
     * 这个函数一次取两份名单，正是最容易一刀切的地方：
     * 原来它开头就是一句「有豁免就三份全空」。
     *
     * 用用户级授权把 viewer 变成有豁免权的人，比铺一套身份组便宜得多。
     */
    setup();
    dbm.db
      .insert(schema.permissionOverrides)
      .values({
        id: "po_1",
        userId: "u_a",
        permissionKey: "moderation.queue",
        granted: true,
        reason: "测试",
        grantedBy: "u_a",
      })
      .run();

    const got = privacy.hiddenWxIds(
      { id: "u_a", wxId: "wx_a", status: "active" } as never,
    );
    assert.deepEqual(got.unsearchable, [], "检索那条该有豁免");
    assert.deepEqual(got.leaderboard, ["wx_c"], "榜单那条不该跟着一起放开");
  });

  it("没设过隐私的人不在任何名单里", () => {
    setup();
    const got = privacy.hiddenWxIds(viewer("wx_a"));
    assert.equal(got.unsearchable.includes("wx_a"), false);
    assert.equal(got.leaderboard.includes("wx_a"), false);
  });
});

describe("**一般什么时候说话：作息有自己的开关**", () => {
  let activity: typeof import("@/lib/members/activity");

  before(async () => {
    activity = await import("@/lib/members/activity");
  });

  const hoursRow = (convId: string, wxId: string, hist: number[], date: string) => {
    dbm.db
      .insert(schema.dailyStats)
      .values({ wxId, convId, date, messages: hist.reduce((a, b) => a + b, 0), hourHistogram: hist })
      .run();
  };
  const nightly = () => Array.from({ length: 24 }, (_, h) => (h >= 22 || h <= 0 ? 40 : 1));

  beforeEach(() => dbm.db.delete(schema.dailyStats).run());

  it("算得出来", () => {
    hoursRow("g1", "alice", nightly(), "2026-01-01");
    const got = activity.activityHoursFor(viewer("bob"), "alice", ["g1"]);
    assert.equal(got?.from, 22);
    assert.equal(got?.label, "深夜型");
  });

  it("**跨群相加** —— 一个人在两个群里的作息是同一套作息", () => {
    hoursRow("g1", "alice", nightly(), "2026-01-01");
    hoursRow("g2", "alice", nightly(), "2026-01-01");
    const one = activity.activityHoursFor(viewer("bob"), "alice", ["g1"])!;
    const two = activity.activityHoursFor(viewer("bob"), "alice", ["g1", "g2"])!;
    assert.equal(two.total, one.total * 2);
  });

  it("**只算共同群** —— 和别的统计同一条边界", () => {
    hoursRow("g2", "alice", nightly(), "2026-01-01");
    assert.equal(activity.activityHoursFor(viewer("bob"), "alice", ["g1"]), null);
  });

  it("**关掉作息开关之后别人看不到**", () => {
    dbm.db.insert(schema.users).values({ id: "u_x", wxId: "alice", status: "active" }).run();
    dbm.db
      .insert(schema.userPrivacy)
      .values({ userId: "u_x", hideActivityHours: true })
      .run();
    hoursRow("g1", "alice", nightly(), "2026-01-01");
    assert.equal(activity.activityHoursFor(viewer("bob"), "alice", ["g1"]), null);
  });

  it("**他自己照常看得到**", () => {
    dbm.db.insert(schema.users).values({ id: "u_x", wxId: "alice", status: "active" }).run();
    dbm.db
      .insert(schema.userPrivacy)
      .values({ userId: "u_x", hideActivityHours: true })
      .run();
    hoursRow("g1", "alice", nightly(), "2026-01-01");
    assert.ok(activity.activityHoursFor(viewer("alice"), "alice", ["g1"]));
  });

  it("**关掉「别人能搜到我的发言」不影响这一条** —— 两个开关各管各的", () => {
    /*
     * 共用一个开关的话，想藏作息的人得连发言一起藏 ——
     * 而那两件事的代价完全不同。
     */
    dbm.db.insert(schema.users).values({ id: "u_x", wxId: "alice", status: "active" }).run();
    dbm.db
      .insert(schema.userPrivacy)
      .values({ userId: "u_x", searchableByOthers: false, hideActivityHours: false })
      .run();
    hoursRow("g1", "alice", nightly(), "2026-01-01");
    assert.ok(activity.activityHoursFor(viewer("bob"), "alice", ["g1"]), "被别的开关连坐了");
  });

  it("**库里那一列是脏的也不能崩** —— 它是 JSON，什么都可能存进去", () => {
    dbm.db
      .insert(schema.dailyStats)
      .values({ wxId: "alice", convId: "g1", date: "2026-01-02", messages: 5, hourHistogram: "坏了" })
      .run();
    hoursRow("g1", "alice", nightly(), "2026-01-01");
    assert.ok(activity.activityHoursFor(viewer("bob"), "alice", ["g1"]));
  });

  it("一行都没有时返回 null", () => {
    assert.equal(activity.activityHoursFor(viewer("bob"), "alice", ["g1"]), null);
  });
});
