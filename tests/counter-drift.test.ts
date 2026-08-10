import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { sql } from "drizzle-orm";

import { stripComments as strip } from "./_source";

/**
 * 缓存计数会不会和源头对不上。
 *
 * ─────────────────────────────────────────
 * 一次把所有派生计数都核了一遍
 * ─────────────────────────────────────────
 *
 * `daily_stats` 那次漂移（累加式统计漏了 26 条）不是孤例的形状 ——
 * 这个站里还有六七个「缓存在别处的计数」。线上逐个对照下来：
 *
 *   积分余额 / 帖子回复数 / 表情数 / 版块帖数 / 群成员数 / 链接分享数
 *     —— **全部一条不差**
 *   群消息数 —— 差 6.5%，而那**不是漂移**：
 *     它来自上游的会话接口，和站里从 `/messages` 拉到的本来就不是一个口径
 *
 * 后一条查清楚花的时间比修还长，但值得：不查清楚的话，
 * 要么误以为丢了三千条消息去「修」，要么以为一切正常而漏掉真的漂移。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

describe("**首页显示的是站里真的有多少条**", () => {
  it("不是上游会话接口报的那个数", () => {
    /*
     * 拿会话计数当「这个群有多少消息」显示，等于告诉人一个
     * 他在这个站里**永远翻不到**的数字 —— 他点进去按天翻，
     * 怎么数都差一截，而差的原因在另一个系统里。
     */
    const q = strip(src("lib/queries/visibility.ts"));
    assert.match(q, /SELECT count\(\*\) FROM messages WHERE messages\.conv_id/);
  });

  it("**理由写在类型旁边** —— 不写的话下一个人会「顺手改回」成缓存列", () => {
    const q = src("lib/queries/visibility.ts");
    assert.match(q, /口径不同|会话计数/);
  });
});

describe("**后台不再把永久差额标成警告**", () => {
  const page = src("app/(app)/admin/groups/page.tsx");

  it("差额用中性色，不是 warning", () => {
    /*
     * 这个差额永远追不平。用黄色标的话，后台上就常驻一个消不掉的告警 ——
     * 而一个永远在响的告警，会让人连真的那次也一起无视。
     */
    const block = page.slice(page.indexOf("group.liveMessages !== group.messageCount"));
    assert.equal(block.slice(0, 800).includes("var(--warning)"), false, "还在标成警告色");
  });

  it("说清楚差在哪儿 —— 不说的话它看起来还是像个故障", () => {
    assert.match(page, /上游会话计数/);
    assert.match(page, /含撤回等拉不到的/);
  });
});

describe("真库：缓存计数和源头对得上", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "al-drift-"));
  process.env.DB_PATH = join(tmp, "test.db");
  process.env.NEKOBOT_API_KEY = "nk_test";

  const dbm = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  const vis = await import("@/lib/queries/visibility");

  after(() => rmSync(tmp, { recursive: true, force: true }));

  it("**可见群列表报的条数 = 消息表里真的有多少条**", () => {
    dbm.db
      .insert(schema.groups)
      .values({
        convId: "g_a",
        name: "A 群",
        isGroup: true,
        syncEnabled: true,
        // 上游会话接口报 999 —— 站里其实只有 2 条
        messageCount: 999,
      })
      .run();
    dbm.db.insert(schema.groupMembers).values({ convId: "g_a", wxId: "wx_me" }).run();
    for (let i = 0; i < 2; i++) {
      dbm.db
        .insert(schema.messages)
        .values({
          id: `m${i}`,
          convId: "g_a",
          senderWxId: "wx_x",
          type: "text",
          content: "x",
          ts: 1_786_000_000_000 + i,
        })
        .run();
    }

    const [g] = vis.visibleGroupsFor({ id: "u", wxId: "wx_me" } as never);
    assert.equal(g.messageCount, 2, "报的是上游那个数，而站里翻不到那么多");
  });

  it("一条消息都没有的群报 0，不报上游那个数", () => {
    dbm.db.run(sql`DELETE FROM messages`);
    const [g] = vis.visibleGroupsFor({ id: "u", wxId: "wx_me" } as never);
    assert.equal(g.messageCount, 0);
  });
});
