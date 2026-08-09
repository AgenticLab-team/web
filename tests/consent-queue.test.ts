import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { stripComments as strip } from "./_source";

/**
 * 「全员已同意，等人提升可见范围」。
 *
 * ─────────────────────────────────────────
 * 这条路走到头之后没有人知道
 * ─────────────────────────────────────────
 *
 * 从群聊整理出来的帖子默认只有原群成员可见。要让更多人看到，
 * 每一位被引用的原作者都要点同意 —— 这条规矩是对的。
 *
 * 问题在**同意齐了之后**：提升可见范围的按钮只有版主看得到
 * （这也是对的，放大别人的话是一次治理动作），
 * 而**没有任何地方告诉版主「这一篇已经齐了」**。
 *
 * 线上真的有一篇停在那儿：三位原作者全同意了，可见性还是 group。
 * 整理的人看到的是「3/3 位原作者同意公开」——
 * 一个看起来该公开却没公开的状态，读起来像是坏了。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

describe("真库", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "al-consent-"));
  process.env.DB_PATH = join(tmp, "test.db");
  process.env.NEKOBOT_API_KEY = "nk_test";

  const dbm = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  const q = await import("@/lib/forum/consent-queue");

  after(() => rmSync(tmp, { recursive: true, force: true }));

  const BOARD = "b_chat";
  const reset = () => {
    for (const t of [schema.postSources, schema.posts, schema.boards]) dbm.db.delete(t).run();
    dbm.db
      .insert(schema.boards)
      .values({ id: BOARD, key: "chat", name: "群聊沉淀", sort: 1, maxVisibility: "public" })
      .run();
  };

  let n = 0;
  const converted = (over: {
    visibility?: string;
    statuses?: ("granted" | "pending" | "denied")[];
    deleted?: boolean;
  }) => {
    const id = `p${++n}`;
    dbm.db
      .insert(schema.posts)
      .values({
        id,
        boardId: BOARD,
        authorId: "u_1",
        title: `帖子 ${id}`,
        content: "正文",
        contentHtml: "<p>正文</p>",
        status: "published",
        visibility: (over.visibility ?? "group") as "group",
        deletedAt: over.deleted ? Date.now() : null,
      })
      .run();
    dbm.db
      .insert(schema.postSources)
      .values({
        postId: id,
        convId: "g_a",
        messageIds: ["m1"],
        convertedBy: "u_1",
        consentLog: (over.statuses ?? ["granted"]).map((status, i) => ({
          wxId: `wx_${i}`,
          status,
        })),
      })
      .run();
    return id;
  };

  it("全员同意 + 还锁在原群 = 在队列里", () => {
    reset();
    const id = converted({ statuses: ["granted", "granted", "granted"] });
    const list = q.readyToRaise();
    assert.deepEqual(list.map((r) => r.postId), [id]);
    assert.equal(list[0].authors, 3);
  });

  it("**还有人没表态就不在队列里** —— 那一步不该催", () => {
    reset();
    converted({ statuses: ["granted", "pending"] });
    assert.deepEqual(q.readyToRaise(), []);
  });

  it("**有人明确不同意也不在** —— 那是定论，不是等待", () => {
    reset();
    converted({ statuses: ["granted", "denied"] });
    assert.deepEqual(q.readyToRaise(), []);
  });

  it("**已经提升过的不再列** —— 再列出来就是噪音", () => {
    reset();
    converted({ visibility: "member", statuses: ["granted"] });
    converted({ visibility: "public", statuses: ["granted"] });
    assert.deepEqual(q.readyToRaise(), []);
  });

  it("删掉的帖子不列", () => {
    reset();
    converted({ statuses: ["granted"], deleted: true });
    assert.deepEqual(q.readyToRaise(), []);
  });

  it("**没有被引用者的转帖不算齐** —— 空名单不是「全员同意」", () => {
    /*
     * `every` 对空数组返回 true，不额外挡一下的话，
     * 一篇谁也没引用的转帖会被当成「全员已同意」。
     */
    reset();
    converted({ statuses: [] });
    assert.deepEqual(q.readyToRaise(), []);
  });

  it("**先转的排前面** —— 等得久的先处理", () => {
    reset();
    const first = converted({ statuses: ["granted"] });
    const second = converted({ statuses: ["granted"] });
    dbm.db
      .update(schema.posts)
      .set({ createdAt: Date.now() - 86_400_000 })
      .where(eq(schema.posts.id, first))
      .run();
    assert.equal(q.readyToRaise()[0].postId, first);
    assert.equal(q.readyToRaise()[1].postId, second);
  });

  it("带上版块封顶 —— 有的版块本来就到不了 public", () => {
    reset();
    dbm.db.update(schema.boards).set({ maxVisibility: "member" }).run();
    converted({ statuses: ["granted"] });
    assert.equal(q.readyToRaise()[0].boardMax, "member");
  });

  describe("还在等的那一批", () => {
    it("有人没表态就列出来，并数清楚还差几位", () => {
      reset();
      converted({ statuses: ["granted", "pending", "pending"] });
      const [w] = q.awaitingConsent();
      assert.equal(w.pending, 2);
      assert.equal(w.authors, 3);
    });

    it("全同意的不在这一批里 —— 它属于上面那个队列", () => {
      reset();
      converted({ statuses: ["granted"] });
      assert.deepEqual(q.awaitingConsent(), []);
    });
  });
});

describe("接线", () => {
  const page = strip(src("app/(app)/admin/reports/page.tsx"));

  it("**摆在举报队列这一页** —— 两者是同一类工作：有人在等一个治理决定", () => {
    // 多开一页的结果是那一页没人每天看，而这件事的失败方式恰恰是「没人看见」
    assert.match(page, /readyToRaise\(\)/);
    assert.match(page, /awaitingConsent\(\)/);
  });

  it("空的时候不占地方", () => {
    assert.match(page, /ready\.length > 0 &&/);
    assert.match(page, /waiting\.length > 0 &&/);
  });

  it("每一条都点得进那篇帖子 —— 不然还得自己去找", () => {
    assert.match(page, /href=\{`\/forum\/p\/\$\{r\.postId\}`\}/);
  });

  it("**说清楚为什么它会卡在这儿**", () => {
    // 只列出来不解释的话，看的人不知道该做什么
    assert.match(page, /只有版主看得到/);
  });
});

describe("**作者那一侧也要知道在等什么**", () => {
  const panel = strip(src("components/forum/ConsentPanel.tsx"));

  it("齐了之后告诉不是版主的人接下来等谁", () => {
    /*
     * 只显示「3/3 位原作者同意公开」而帖子还锁着的话，读起来像是坏了 ——
     * 整理的人多半会以为是自己哪一步没做完，然后去点一遍所有按钮。
     */
    assert.match(panel, /!canModerate && summary\.canRaise/);
    assert.match(panel, /所有原作者都同意了/);
  });

  it("**顺带解释为什么不是他自己按** —— 否则那句话像在推诿", () => {
    assert.match(panel, /治理动作/);
  });

  it("没齐的时候不显示这句 —— 那会变成催人表态", () => {
    const block = panel.slice(panel.indexOf("!canModerate && summary.canRaise"));
    assert.match(block.slice(0, 300), /所有原作者都同意了/);
  });
});
