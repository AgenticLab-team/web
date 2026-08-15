import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

/**
 * 审计里那一列危险等级：**「只看高危」这个筛选靠它**。
 *
 * ═════════════════════════════════════════
 * 读取侧的兜底，把写入侧的洞盖住了
 * ═════════════════════════════════════════
 *
 * `audit()` 写入时算一次 `dangerLevelOf(entry.action)` 存进去。
 * 把它改成恒为 0，**一条测试都不红** —— 因为读取那边有一句兜底：
 *
 *     dangerLevel: row.dangerLevel || dangerLevelOf(row.action)
 *
 * 于是后台页面上显示的等级永远是对的，任何「看显示」的测试都过。
 *
 * 而「只看高危」那个筛选走的是 **SQL**：
 *
 *     if (filter.minDanger) conditions.push(gte(auditLogs.dangerLevel, …))
 *
 * 它查的是**存下来的那一列**，兜底管不着。
 * 于是高危操作会从「只看高危」里整个消失 —— 而页面看起来一切正常，
 * 一条不落地显示着，只是筛选之后空了。
 *
 * 这一条测试因此不看显示，只问筛选。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-auditdanger-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

describe("审计的危险等级", async () => {
  const dbm = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  const { audit } = await import("@/lib/audit");
  const { queryAuditLogs } = await import("@/lib/admin/audit-query");
  const { dangerLevelOf } = await import("@/lib/rbac/permissions");

  after(() => rmSync(tmp, { recursive: true, force: true }));

  const CTX = { actorId: "u_admin", actorRole: "admin", actorIp: "127.0.0.1" };
  const DANGEROUS = "user.bind.manual"; // dangerLevel 2
  const PLAIN = "settings.update";

  beforeEach(() => {
    dbm.db.delete(schema.auditLogs).run();
  });

  it("先确认这两个动作的等级确实不一样 —— 否则下面测的是空气", () => {
    assert.ok(dangerLevelOf(DANGEROUS) >= 2, `${DANGEROUS} 不再是高危动作了，换一个`);
    assert.ok(dangerLevelOf(PLAIN) < 2, `${PLAIN} 变成高危了，换一个`);
  });

  it("★ 高危动作要能被「只看高危」筛出来 —— 那个筛选查的是存下来的那一列", () => {
    audit(CTX, { action: DANGEROUS, targetType: "user", targetId: "u_x", reason: "测试" });
    audit(CTX, { action: PLAIN, targetType: "setting", targetId: "k", reason: "测试" });

    const all = queryAuditLogs({});
    assert.equal(all.total, 2, "两条都该在");

    const risky = queryAuditLogs({ minDanger: 2 });
    assert.equal(risky.total, 1, "高危操作从「只看高危」里消失了");
    assert.equal(risky.entries[0].action, DANGEROUS);
  });

  it("对照：普通动作不该被高危筛选捞出来", () => {
    audit(CTX, { action: PLAIN, targetType: "setting", targetId: "k", reason: "测试" });
    assert.equal(queryAuditLogs({ minDanger: 2 }).total, 0, "普通操作混进了高危里");
  });
});
