import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

/**
 * 「可以买置顶的帖子」这份候选列表。
 *
 * ─────────────────────────────────────────
 * 这条测试是被一次逃掉的变异逼出来的
 * ─────────────────────────────────────────
 *
 * 清理死导出时删掉了 `isPinExpired`（它是 `isEffectivelyPinned` 的
 * 重复实现，没有任何调用方）。删完顺手做了个变异检验：
 * 把 `shop/queries.ts` 里那句
 * `.filter((p) => !isEffectivelyPinned(p, now))` 改成恒真 ——
 * **全量测试一条都没红**。
 *
 * 也就是说：`isEffectivelyPinned` 这个纯函数被测得很细，
 * 而**它在生产里唯一的调用点没有任何覆盖**。
 *
 * 那句 filter 不是装饰：它的作用是别把「已经在置顶中」的帖子
 * 摆进选单。摆进去的结果是有人挑了它、花掉积分、换来一次
 * 「兑换失败」—— 而积分是这个站里唯一的硬通货。
 *
 * ─────────────────────────────────────────
 * 「置顶中」有两种，别漏了第二种
 * ─────────────────────────────────────────
 *
 * `pinned = 1` 只说明它曾经被置顶过。真正还生效的判断要连
 * `pinned_until` 一起看 —— 一个「置顶一天」到期之后，
 * 布尔位还是 1，而它**应该重新可以买**。
 */

const TMP = mkdtempSync(join(tmpdir(), "al-pinnable-"));
process.env.DB_PATH = join(TMP, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";
process.env.SITE_URL = "https://example.test";

describe("可以买置顶的帖子", async () => {
  const dbm = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  const { pinnablePosts } = await import("@/lib/shop/queries");

  after(() => rmSync(TMP, { recursive: true, force: true }));

  const ME = "u_me";
  const OTHER = "u_other";
  const NOW = Date.UTC(2026, 7, 10, 12);
  const HOUR = 3_600_000;

  let seq = 0;
  function post(over: Partial<typeof schema.posts.$inferInsert> = {}) {
    const id = `p${++seq}`;
    dbm.db
      .insert(schema.posts)
      .values({
        id,
        boardId: "b1",
        authorId: ME,
        title: `帖子 ${id}`,
        content: "正文",
        contentHtml: "<p>正文</p>",
        status: "published",
        ...over,
      })
      .run();
    return id;
  }

  const reset = () => dbm.db.delete(schema.posts).run();
  const ids = () => pinnablePosts(ME, NOW).map((p) => p.id);

  it("普通帖子在候选里", () => {
    reset();
    const id = post();
    assert.deepEqual(ids(), [id]);
  });

  it("**正在置顶中的不列** —— 让人选一个买不了的选项，只会换来一次「兑换失败」", () => {
    reset();
    post({ pinned: true, pinnedUntil: NOW + 24 * HOUR });
    assert.deepEqual(ids(), []);
  });

  it("**永久置顶的也不列**（pinned_until 为空 = 手动置顶，不会自己到期）", () => {
    reset();
    post({ pinned: true, pinnedUntil: null });
    assert.deepEqual(ids(), []);
  });

  it("**置顶到期之后重新可以买** —— 布尔位还是 1，但它已经不生效了", () => {
    /*
     * 只看 `pinned` 这个布尔的话，一次「置顶一天」会让这篇帖子
     * 从此再也买不了置顶 —— 而且没有任何地方看得出来。
     */
    reset();
    const id = post({ pinned: true, pinnedUntil: NOW - 1 });
    assert.deepEqual(ids(), [id]);
  });

  it("**别人的帖子不在我的候选里**", () => {
    reset();
    post({ authorId: OTHER });
    assert.deepEqual(ids(), []);
  });

  it("草稿、隐藏、已删的都不列", () => {
    reset();
    post({ status: "draft" });
    post({ status: "hidden" });
    post({ deletedAt: Date.now() });
    assert.deepEqual(ids(), []);
  });

  it("**混在一起时只留下该留的那一条**", () => {
    reset();
    const ok = post();
    post({ pinned: true, pinnedUntil: NOW + HOUR });
    post({ authorId: OTHER });
    post({ status: "draft" });
    const expired = post({ pinned: true, pinnedUntil: NOW - HOUR });
    assert.deepEqual(ids().sort(), [ok, expired].sort());
  });
});
