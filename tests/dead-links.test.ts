import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { stripComments as strip } from "./_source";

/**
 * 点进去什么也没有的入口。
 *
 * ─────────────────────────────────────────
 * 线上 95 条通知里有 10 条是死链
 * ─────────────────────────────────────────
 *
 * 「有人回复了你的帖子」，而那篇帖子后来被删了 ——
 * 通知还在列表里，点一下是个 404。
 *
 * **一个不可信的入口比没有入口更糟**：点了两次 404 之后，
 * 人就不再点任何通知了，而那会把真正要紧的那一条一起废掉。
 *
 * 处理办法是如实标出来，不是删掉这条通知 ——
 * 那件事确实发生过，抹掉等于篡改历史，
 * 而且用户会记得自己见过这条、然后找不到了。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

describe("真库", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "al-deadlink-"));
  process.env.DB_PATH = join(tmp, "test.db");
  process.env.NEKOBOT_API_KEY = "nk_test";

  const dbm = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  const notify = await import("@/lib/forum/notify");

  after(() => rmSync(tmp, { recursive: true, force: true }));

  const USER = "u_me";
  let n = 0;
  const reset = () => {
    for (const t of [schema.notifications, schema.posts, schema.messages, schema.users]) {
      dbm.db.delete(t).run();
    }
    dbm.db.insert(schema.users).values({ id: USER, wxId: "wx_me", status: "active" }).run();
  };

  const post = (id: string, deleted = false) =>
    dbm.db
      .insert(schema.posts)
      .values({
        id,
        boardId: "b1",
        authorId: USER,
        title: "帖子",
        content: "x",
        contentHtml: "<p>x</p>",
        status: "published",
        deletedAt: deleted ? Date.now() : null,
      })
      .run();

  const notif = (link: string | null) =>
    dbm.db
      .insert(schema.notifications)
      .values({
        userId: USER,
        type: "reply_to_post",
        title: "有人回复了你",
        link,
        groupKey: `k${++n}`,
      })
      .run();

  const first = () => notify.listNotifications(USER, 10)[0];

  it("目标还在 → 不标", () => {
    reset();
    post("p1");
    notif("/forum/p/p1");
    assert.equal(first().targetGone, false);
  });

  it("**帖子被删了 → 标出来**", () => {
    reset();
    post("p1", true);
    notif("/forum/p/p1");
    assert.equal(first().targetGone, true);
  });

  it("**帖子整行都没了 → 也标出来**", () => {
    reset();
    notif("/forum/p/nope");
    assert.equal(first().targetGone, true);
  });

  it("消息链接同理", () => {
    reset();
    dbm.db
      .insert(schema.messages)
      .values({
        id: "m1",
        convId: "g_a",
        senderWxId: "wx_x",
        type: "text",
        content: "x",
        ts: 1,
      })
      .run();
    notif("/archive?group=g_a&m=m1#msg-m1");
    assert.equal(first().targetGone, false);

    reset();
    notif("/archive?group=g_a&m=gone#msg-gone");
    assert.equal(first().targetGone, true);
  });

  it("**认不出来的链接一律当成还在** —— 判不准时不该把好链接说成坏的", () => {
    reset();
    notif("/me/security");
    assert.equal(first().targetGone, false);
  });

  it("没有链接的也不标 —— 它本来就不指向任何东西", () => {
    reset();
    notif(null);
    assert.equal(first().targetGone, false);
  });

  it("**通知本身不删** —— 那件事确实发生过", () => {
    reset();
    post("p1", true);
    notif("/forum/p/p1");
    assert.equal(notify.listNotifications(USER, 10).length, 1);
  });
});

describe("界面", () => {
  const row = strip(src("components/notifications/NotificationRow.tsx"));

  it("死链渲染成按钮，不是链接", () => {
    assert.match(row, /if \(!href \|\| targetGone\)/);
  });

  it("**还能点掉** —— 一条永远消不掉的未读会让人放弃整个通知页", () => {
    const block = row.slice(row.indexOf("if (!href || targetGone)"));
    assert.match(block.slice(0, 300), /onClick=\{mark\}/);
  });

  it("写明原因", () => {
    assert.match(row, /这条内容已经被删掉了/);
  });

  it("页面把这个字段传下去了", () => {
    assert.match(strip(src("app/(app)/notifications/page.tsx")), /targetGone=\{item\.targetGone\}/);
  });
});

describe("**@ 解析不出来时那句提示要说实话**", () => {
  it("不再说「对方可能已改名或退群」", () => {
    /*
     * 线上 553 条解析不出的 @ 里，**549 条的名字在那个群里
     * 从没有人用过** —— 连历史发言名都对不上。
     *
     * 也就是说它们根本不是在 @ 真人（「妈妈」「群里面最擅长
     * 断章取义的人」这种），而是 @ 形状的自由文本。
     * 原来那句话把绝大多数情况说反了。
     */
    const text = src("components/messages/MessageText.tsx");
    assert.equal(text.includes("对方可能已改名或退群"), false);
    assert.match(text, /微信的 @ 是自由文本/);
  });

  it("同名多人那一条不变 —— 它说的是另一回事", () => {
    assert.match(src("components/messages/MessageText.tsx"), /有多名同名成员/);
  });
});
