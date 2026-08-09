import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  MAX_DURATION_SECONDS,
  PRESETS,
  checkDuration,
  describeRemaining,
  isActive,
  statusAfterExpiry,
} from "@/lib/moderation/duration-rules";
import { stripComments as strip } from "./_source";

/**
 * 封禁期限。
 *
 * ─────────────────────────────────────────
 * 两列零引用 = 每一次封禁都是永久的
 * ─────────────────────────────────────────
 *
 * `moderation_actions` 上 `duration_seconds` 和 `expires_at`
 * 在 schema 之外没有任何地方读或写。「封 7 天」这件事做不到，
 * 想解封只能有人记得手动回来解。
 *
 * 而后果落在被封的人身上：他打开「处罚与申诉」看到的是一句
 * 没有期限的「账号被封禁」。一个不知道什么时候结束的处罚，
 * 和永久封禁在心理上是一回事 —— 于是他不会等，他会走。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

const NOW = 1_800_000_000_000;

describe("期限校验", () => {
  it("永久就是 null，两个字段都空", () => {
    const r = checkDuration(null, NOW);
    assert.equal(r.ok && r.durationSeconds, null);
    assert.equal(r.ok && r.expiresAt, null);
  });

  it("正常的算出到期时间", () => {
    const r = checkDuration(7 * 86_400, NOW);
    assert.equal(r.ok && r.expiresAt, NOW + 7 * 86_400_000);
  });

  it("零和负数拒", () => {
    assert.equal(checkDuration(0, NOW).ok, false);
    assert.equal(checkDuration(-1, NOW).ok, false);
  });

  it("**超过一年直接让人选永久** —— 写个大数字只是让人以为还有指望", () => {
    const r = checkDuration(MAX_DURATION_SECONDS + 1, NOW);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /还有指望/);
  });

  it("预设里既有短的也有永久", () => {
    assert.ok(PRESETS.some((p) => p.seconds !== null && p.seconds <= 86_400));
    assert.ok(PRESETS.some((p) => p.seconds === null));
  });
});

describe("**还生效吗**", () => {
  it("永久的永远生效", () => {
    assert.equal(isActive({ expiresAt: null, revertedAt: null }, NOW), true);
  });

  it("没到期的生效，到期的不生效", () => {
    assert.equal(isActive({ expiresAt: NOW + 1000, revertedAt: null }, NOW), true);
    assert.equal(isActive({ expiresAt: NOW - 1, revertedAt: null }, NOW), false);
  });

  it("**撤销优先于期限** —— 被申诉撤掉的封禁不该在到期前一直算数", () => {
    assert.equal(isActive({ expiresAt: null, revertedAt: NOW - 5 }, NOW), false);
    assert.equal(isActive({ expiresAt: NOW + 99999, revertedAt: NOW - 5 }, NOW), false);
  });
});

describe("给被处罚的人看的那句话", () => {
  it("**说「还有多久」，不是一个要自己算的时间戳**", () => {
    assert.equal(describeRemaining(NOW + 3 * 86_400_000, NOW), "还有 3 天");
  });

  it("不到一天说小时", () => {
    assert.equal(describeRemaining(NOW + 5 * 3_600_000, NOW), "还有 5 小时");
  });

  it("不到一小时也说得出来 —— 那时候人最想知道", () => {
    assert.match(describeRemaining(NOW + 60_000, NOW), /不到 1 小时/);
  });

  it("永久和已到期各说各的", () => {
    assert.equal(describeRemaining(null, NOW), "永久");
    assert.equal(describeRemaining(NOW - 1, NOW), "已经到期");
  });
});

describe("**到期恢复成什么状态**", () => {
  it("封禁和暂停都回 active", () => {
    assert.equal(statusAfterExpiry("banned"), "active");
    assert.equal(statusAfterExpiry("suspended"), "active");
  });

  it("**别的状态一概不动**", () => {
    /*
     * 恢复成「封之前那个」听起来更周到，实际是个坑：一个 pending
     * 的账号被封 7 天，到期恢复成 pending 之后仍然进不来，
     * 而处罚在所有界面上都显示成已经结束了。
     *
     * left / deleted 更不该自动恢复 —— 那不是处罚，
     * 是这个人自己走了或者账号被清理了。
     */
    for (const s of ["pending", "left", "deleted", "active"]) {
      assert.equal(statusAfterExpiry(s), null, `${s} 被自动改了`);
    }
  });
});

describe("接线", () => {
  it("setUserStatus 收期限并写进处罚记录", () => {
    const actions = strip(src("lib/admin/user-actions.ts"));
    assert.match(actions, /durationSeconds\?: number \| null/);
    assert.match(actions, /checkDuration\(input\.durationSeconds \?\? null/);
    assert.match(actions, /durationSeconds: input\.status === "active" \? null : duration\.durationSeconds/);
  });

  it("**「恢复正常」不带期限** —— 「解封 7 天」不成句", () => {
    const actions = strip(src("lib/admin/user-actions.ts"));
    assert.match(actions, /expiresAt: input\.status === "active" \? null : duration\.expiresAt/);
  });

  it("**有人去扫到期** —— 只写 expires_at 而没人扫，等于把「7 天」写成一句安慰话", () => {
    const health = readFileSync(new URL("../scripts/health.ts", import.meta.url), "utf8");
    assert.match(health, /name: "到期解封"/);
    assert.match(health, /releaseExpiredBans\(\)/);
  });

  it("解封要通知本人 —— 否则他不知道自己什么时候能回来", () => {
    const expiry = strip(src("lib/moderation/expiry.ts"));
    assert.match(expiry, /type: "moderation"/);
    assert.match(expiry, /处罚已经到期/);
  });

  it("被封的人自己看得到还剩多久", () => {
    assert.match(src("app/(app)/me/moderation/page.tsx"), /record\.remaining/);
    assert.match(src("lib/forum/appeals-queries.ts"), /describeRemaining\(action\.expiresAt, now\)/);
  });

  it("**「还剩多久」在查询层算** —— 页面里读时钟会让两行用上不同的「现在」", () => {
    const page = strip(src("app/(app)/me/moderation/page.tsx"));
    assert.doesNotMatch(page, /Date\.now\(\)/);
  });

  it("默认选 7 天不是永久 —— 默认值是一种表态", () => {
    assert.match(src("components/admin/UserActions.tsx"), /useState<number \| null>\(7 \* 86_400\)/);
  });

  it("规则层不碰数据库", () => {
    const code = src("lib/moderation/duration-rules.ts");
    for (const forbidden of ["server-only", "@/lib/db", "drizzle-orm"]) {
      assert.equal(code.includes(forbidden), false, `规则层引了 ${forbidden}`);
    }
  });
});

/* ───────────────────────────────────────────────────────────────
 * 解封那一轮只有真数据库测得出来
 * ─────────────────────────────────────────────────────────────── */

const tmp = mkdtempSync(join(tmpdir(), "al-ban-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

let dbm: typeof import("@/lib/db");
let schema: typeof import("@/lib/db/schema");
let expiry: typeof import("@/lib/moderation/expiry");
let eq: typeof import("drizzle-orm").eq;

const USER = "u_a";

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  expiry = await import("@/lib/moderation/expiry");
  ({ eq } = await import("drizzle-orm"));
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  dbm.db.delete(schema.moderationActions).run();
  dbm.db.delete(schema.notifications).run();
  dbm.db.delete(schema.users).run();
  dbm.db.insert(schema.users).values({ id: USER, wxId: "wx_a", status: "banned" }).run();
});

function ban(over: Partial<typeof schema.moderationActions.$inferInsert> = {}) {
  dbm.db
    .insert(schema.moderationActions)
    .values({
      actorId: "admin",
      targetType: "user",
      targetId: USER,
      targetUserId: USER,
      action: "ban",
      reason: "测试",
      ...over,
    })
    .run();
}

const statusOf = () =>
  dbm.db.select().from(schema.users).where(eq(schema.users.id, USER)).get()?.status;

describe("到期解封（真数据）", () => {
  it("到点的解开", () => {
    ban({ expiresAt: NOW - 1000 });
    const r = expiry.releaseExpiredBans(NOW);
    assert.equal(r.unbanned, 1);
    assert.equal(statusOf(), "active");
  });

  it("没到点的不动", () => {
    ban({ expiresAt: NOW + 86_400_000 });
    assert.equal(expiry.releaseExpiredBans(NOW).unbanned, 0);
    assert.equal(statusOf(), "banned");
  });

  it("**永久的永远不解**", () => {
    ban({ expiresAt: null });
    assert.equal(expiry.releaseExpiredBans(NOW).unbanned, 0);
    assert.equal(statusOf(), "banned");
  });

  it("**已经撤销的不再解一次** —— 那会写出一条莫名其妙的解封记录", () => {
    ban({ expiresAt: NOW - 1000, revertedAt: NOW - 500 });
    assert.equal(expiry.releaseExpiredBans(NOW).unbanned, 0);
  });

  it("**身上还有别的没到期的处罚 —— 不放人**", () => {
    /*
     * 封 7 天之后又被封 30 天，第 7 天到了就放人的话，
     * 第二条处罚等于没发生。
     */
    ban({ expiresAt: NOW - 1000, reason: "第一条" });
    ban({ expiresAt: NOW + 30 * 86_400_000, reason: "第二条" });

    assert.equal(expiry.releaseExpiredBans(NOW).unbanned, 0);
    assert.equal(statusOf(), "banned");
  });

  it("两条都到期了才放", () => {
    ban({ expiresAt: NOW - 2000, reason: "第一条" });
    ban({ expiresAt: NOW - 1000, reason: "第二条" });
    assert.equal(expiry.releaseExpiredBans(NOW).unbanned, 1);
    assert.equal(statusOf(), "active");
  });

  it("**当事人现在不是被封状态就不动他**", () => {
    /*
     * 他自己退群了 / 账号被清理了 —— 那不是处罚，
     * 自动改回 active 会让一个已经离开的账号复活。
     */
    dbm.db.update(schema.users).set({ status: "left" }).where(eq(schema.users.id, USER)).run();
    ban({ expiresAt: NOW - 1000 });

    const r = expiry.releaseExpiredBans(NOW);
    assert.equal(r.unbanned, 0);
    assert.equal(r.skipped, 1);
    assert.equal(statusOf(), "left");
  });

  it("解开之后通知本人，并留一条解封记录", () => {
    ban({ expiresAt: NOW - 1000 });
    expiry.releaseExpiredBans(NOW);

    const inbox = dbm.db.select().from(schema.notifications).all();
    assert.equal(inbox.length, 1);
    assert.match(inbox[0].title, /到期/);

    const unbans = dbm.db
      .select()
      .from(schema.moderationActions)
      .all()
      .filter((r) => r.action === "unban");
    assert.equal(unbans.length, 1);
    assert.equal(unbans[0].actorId, "system");
  });

  it("**跑两遍不会解两次**", () => {
    ban({ expiresAt: NOW - 1000 });
    assert.equal(expiry.releaseExpiredBans(NOW).unbanned, 1);
    // 第二遍：人已经是 active 了，statusAfterExpiry 返回 null
    assert.equal(expiry.releaseExpiredBans(NOW).unbanned, 0);
    assert.equal(dbm.db.select().from(schema.notifications).all().length, 1);
  });

  it("activePunishment 找得出现在生效的那条", () => {
    ban({ expiresAt: NOW + 86_400_000, reason: "还在生效" });
    const active = expiry.activePunishment(USER, NOW);
    assert.equal(active?.reason, "还在生效");
  });

  it("全都到期时 activePunishment 是 null", () => {
    ban({ expiresAt: NOW - 1000 });
    assert.equal(expiry.activePunishment(USER, NOW), null);
  });
});
