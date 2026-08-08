import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

/**
 * 配置的写入链路。
 *
 * 三件事必须同时成立：**校验、三处留痕、缓存失效**。
 * 少了校验，后台显示的和实际生效的会不是一回事；
 * 少了留痕，事后没人说得清是谁改的；
 * 少了缓存失效，改了要等进程重启才生效 —— 那是最迷惑人的一种。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-settings-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

type Store = typeof import("@/lib/settings/store");
type Admin = typeof import("@/lib/admin/settings");
type DbModule = typeof import("@/lib/db");
type SchemaModule = typeof import("@/lib/db/schema");

let store: Store;
let adminSettings: Admin;
let dbm: DbModule;
let schema: SchemaModule;

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  const { seedDatabase } = await import("@/lib/db/seed");
  seedDatabase();
  store = await import("@/lib/settings/store");
  adminSettings = await import("@/lib/admin/settings");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  dbm.db.delete(schema.settingHistory).run();
  dbm.db.delete(schema.auditLogs).run();
  dbm.db
    .update(schema.settings)
    .set({ value: "10", updatedBy: null })
    .where(eq(schema.settings.key, "points.checkin.base"))
    .run();
  store.invalidateSettingsCache();
});

const KEY = "points.checkin.base";

describe("写入侧校验", () => {
  it("**非法值在保存的那一刻就被拒**", () => {
    // 靠读取侧兜底的话，页面上会显示 6O 而系统在用 10，
    // 没有任何地方报错
    assert.throws(() => store.updateSetting(KEY, "6O", { actorId: "u1" }), /整数/);
  });

  it("被拒之后数据库里的值没变", () => {
    try {
      store.updateSetting(KEY, "abc", { actorId: "u1" });
    } catch {
      /* 预期抛出 */
    }
    assert.equal(store.getSettingInt(KEY, 0), 10);
  });

  it("被拒之后不会留下变更历史 —— 没发生的事不该有记录", () => {
    try {
      store.updateSetting(KEY, "abc", { actorId: "u1" });
    } catch {
      /* 预期抛出 */
    }
    assert.equal(dbm.db.select().from(schema.settingHistory).all().length, 0);
  });

  it("合法值正常保存", () => {
    store.updateSetting(KEY, "20", { actorId: "u1", reason: "调高打卡基础分" });
    assert.equal(store.getSettingInt(KEY, 0), 20);
  });

  it("**归一化之后相同的值不算变更**", () => {
    // 否则「020」和「20」会被记成一次改动，历史里全是噪音
    store.updateSetting(KEY, "010", { actorId: "u1", reason: "试试" });
    assert.equal(dbm.db.select().from(schema.settingHistory).all().length, 0);
  });
});

describe("三处留痕", () => {
  it("写 settings + setting_history + audit_logs", () => {
    store.updateSetting(KEY, "25", { actorId: "u_admin", reason: "活动期间调高" });

    const row = dbm.db.select().from(schema.settings).where(eq(schema.settings.key, KEY)).get()!;
    assert.equal(row.value, "25");
    assert.equal(row.updatedBy, "u_admin");

    const history = dbm.db.select().from(schema.settingHistory).all();
    assert.equal(history.length, 1);
    assert.equal(history[0].oldValue, "10");
    assert.equal(history[0].newValue, "25");
    assert.equal(history[0].reason, "活动期间调高");

    const audits = dbm.db.select().from(schema.auditLogs).all();
    assert.equal(audits.length, 1);
    assert.equal(audits[0].targetId, KEY);
  });

  it("**改前的值被记下来** —— 没有它就没法回滚，也没法复盘", () => {
    store.updateSetting(KEY, "30", { actorId: "u1", reason: "一" });
    store.updateSetting(KEY, "40", { actorId: "u1", reason: "二" });

    const history = dbm.db.select().from(schema.settingHistory).all();
    assert.equal(history.length, 2);
    assert.ok(history.some((h) => h.oldValue === "10" && h.newValue === "30"));
    assert.ok(history.some((h) => h.oldValue === "30" && h.newValue === "40"));
  });
});

describe("缓存失效", () => {
  it("**改完立刻生效，不用等进程重启**", () => {
    // 少了这一步是最迷惑人的：数据库里是新值，系统在用旧值
    assert.equal(store.getSettingInt(KEY, 0), 10);
    store.updateSetting(KEY, "88", { actorId: "u1" });
    assert.equal(store.getSettingInt(KEY, 0), 88);
  });
});

describe("未知配置项", () => {
  it("拒绝写入不存在的键 —— 否则会凭空造出一个没人读的配置", () => {
    assert.throws(() => store.updateSetting("不存在的键", "1", { actorId: "u1" }), /未知配置项/);
  });
});

describe("后台视图", () => {
  it("按分类归组，且每项都有中文分类名", () => {
    const categories = adminSettings.listSettings();
    assert.ok(categories.length > 0);
    assert.ok(categories.every((c) => c.label.length > 0));
  });

  it("**被改过的项被标出来**", () => {
    store.updateSetting(KEY, "99", { actorId: "u1", reason: "测试" });

    const item = adminSettings
      .listSettings()
      .flatMap((c) => c.items)
      .find((i) => i.key === KEY)!;
    assert.equal(item.modified, true);
    assert.equal(item.changeCount, 1);
  });

  it("没改过的项不标", () => {
    const item = adminSettings
      .listSettings()
      .flatMap((c) => c.items)
      .find((i) => i.key === KEY)!;
    assert.equal(item.modified, false);
  });

  it("**判定规则类的项带追溯提醒**", () => {
    const item = adminSettings
      .listSettings()
      .flatMap((c) => c.items)
      .find((i) => i.key === "sync.quality_min")!;
    assert.equal(item.retroactive, true);
    assert.equal(item.dangerous, true, "它改错会让榜单长期与规则不一致");
  });

  it("变更历史按时间倒序，带出改动人", () => {
    store.updateSetting(KEY, "11", { actorId: "u1", reason: "一" });
    store.updateSetting(KEY, "12", { actorId: "u1", reason: "二" });

    const history = adminSettings.settingHistoryOf(KEY);
    assert.equal(history.length, 2);
    assert.equal(history[0].reason, "二", "最新的排最前");
    assert.ok(history[0].changedByName.length > 0);
  });

  it("统计被改过的项数", () => {
    assert.equal(adminSettings.modifiedCount(), 0);
    store.updateSetting(KEY, "77", { actorId: "u1" });
    assert.equal(adminSettings.modifiedCount(), 1);
  });
});
