import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

/**
 * 锁死的模块，**设置里写了 false 也得当它开着**。
 *
 * ═════════════════════════════════════════
 * 两层防线，而第二层没人守
 * ═════════════════════════════════════════
 *
 * 「审计日志」这个模块是 `lockedOn` 的，理由写在注册表里：
 * 「关掉审计等于让后台操作无迹可查 —— 这个开关本身就该是不存在的」。
 *
 * 防线有两层：
 *
 *   ① `modules/actions.ts` 里那句 `if (spec.lockedOn) return 不许关`
 *   ② `modules/state.ts` 里那句 `if (moduleByKey(key)?.lockedOn) return true`
 *      —— 不管设置里存的是什么，一律当开着
 *
 * `tests/modules.test.ts` 是纯静态的（只读注册表），守的是
 * 「锁死的模块不该声明判定点」「要写明锁的理由」这类形状；
 * 而 `scripts/mutate.mjs` 把第②层删掉之后**一条测试都不红**。
 *
 * 第②层防的不是管理员点错 —— 那是第①层的事。它防的是
 * **设置被别处写坏**：一次迁移、一次手改库、一次带 bug 的批量脚本。
 * 那时候第①层根本不在路径上，只剩这一句。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-modlock-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

describe("锁死的模块", async () => {
  const dbm = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  const store = await import("@/lib/settings/store");
  const { MODULES } = await import("@/lib/modules/registry");
  const { isModuleEnabled } = await import("@/lib/modules/state");

  after(() => rmSync(tmp, { recursive: true, force: true }));

  /** 把某个模块的设置强行写成 false —— 模拟「设置被别处写坏」 */
  const forceOff = (settingKey: string) => {
    dbm.db
      .insert(schema.settings)
      .values({ key: settingKey, value: "false", type: "bool", category: "module" })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: "false" } })
      .run();
    store.invalidateSettingsCache();
  };

  it("★ 设置里写着 false，`isModuleEnabled` 也必须说开着", () => {
    const locked = MODULES.filter((m) => m.lockedOn);
    assert.ok(locked.length > 0, "注册表里一个锁死的模块都没有 —— 这条测试就没意义了");

    for (const spec of locked) {
      forceOff(spec.settingKey);
      assert.equal(
        isModuleEnabled(spec.key),
        true,
        `${spec.key} 被设置关掉了 —— 而它锁死的理由是：${spec.lockReason}`,
      );
    }
  });

  it("对照：没锁的模块，设置说关就是关", () => {
    /*
     * 没有这一条的话，上面那条也可能是因为 `isModuleEnabled` 恒返回 true ——
     * 那样它测的是个假的安心。
     */
    const normal = MODULES.find((m) => !m.lockedOn);
    assert.ok(normal, "注册表里全是锁死的模块？");
    forceOff(normal.settingKey);
    assert.equal(isModuleEnabled(normal.key), false, "关掉的模块还报开着");
  });
});
