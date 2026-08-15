import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

/**
 * 设备码限流的**行为**测试。
 *
 * ═════════════════════════════════════════
 * 为什么原来那条测试拦不住
 * ═════════════════════════════════════════
 *
 * `tests/client-ip.test.ts` 里已经有一条：检查路由源码里
 * 有没有调用 `tooManyDeviceStarts(`。那一条守的是「有没有接上」，
 * 而不是「接上之后管不管用」。
 *
 * `scripts/mutate.mjs` 把函数**内部**的判断删掉（`if (recent < max)`
 * 直接 `return null`），路由里那句调用原封不动 ——
 * 于是源码断言照旧绿，而闸门整个没了。
 * 时间窗从一小时改成一天（放宽 24 倍）同样没人管。
 *
 * 而这个接口是全站**唯一一个未鉴权就能写库**的公网端点
 * （设备码流程本来就从没有凭证开始），限流是它唯一的闸。
 * 所以这里补的是真的行为：喂进去 N 条记录，问它拦不拦。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-devrate-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

describe("设备码限流", async () => {
  const dbm = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  const store = await import("@/lib/settings/store");
  const { tooManyDeviceStarts } = await import("@/lib/tui/device-ratelimit");

  after(() => rmSync(tmp, { recursive: true, force: true }));

  const IP = "203.0.113.7";
  const NOW = 1_760_000_000_000;

  const setMax = (n: number) => {
    dbm.db.delete(schema.settings).run();
    dbm.db
      .insert(schema.settings)
      .values({
        key: "tui.device.max_starts_per_hour",
        value: String(n),
        type: "int",
        category: "tui",
      })
      .run();
    store.invalidateSettingsCache();
  };

  /** 造 n 条来自同一个 IP 的请码记录，`agoMs` 是多久以前 */
  const seedCodes = (n: number, agoMs = 0, ip = IP) => {
    for (let i = 0; i < n; i++) {
      dbm.db
        .insert(schema.deviceCodes)
        .values({
          userCodeHash: `uc_${ip}_${agoMs}_${i}`,
          deviceCodeHash: `dc_${ip}_${agoMs}_${i}`,
          status: "pending",
          source: "cli",
          deviceLabel: "审计用的假设备",
          scopes: "read",
          requestIp: ip,
          createdAt: NOW - agoMs,
          expiresAt: NOW + 600_000,
        })
        .run();
    }
  };

  beforeEach(() => {
    dbm.db.delete(schema.deviceCodes).run();
    setMax(5);
  });

  it("没到上限就放行", () => {
    seedCodes(4);
    assert.equal(tooManyDeviceStarts(IP, NOW), null);
  });

  it("★ 到了上限就拦，并给出等多久", () => {
    seedCodes(5);
    const verdict = tooManyDeviceStarts(IP, NOW);
    assert.ok(verdict, "到了上限还放行 —— 这个端点没有别的闸");
    assert.ok(verdict.retryAfterSeconds > 0, "拦下来却不说等多久");
  });

  it("★ 只数**一小时以内**的 —— 窗口放宽等于放宽上限", () => {
    /*
     * 这一条钉的是那个 `3_600_000`。
     * 把它改成一天，上限就等于放宽了 24 倍，而没有任何地方会报错：
     * 每小时 5 次变成每天 5 次，看起来更严，实际是一小时里能要 5 次、
     * 然后接下来 23 小时一次都要不到 —— 两种坏法都不是原意。
     */
    seedCodes(5, 3_600_000 + 60_000); // 一小时零一分钟以前
    assert.equal(tooManyDeviceStarts(IP, NOW), null, "一小时以前的记录还在占配额");

    seedCodes(5, 60_000); // 一分钟以前
    assert.ok(tooManyDeviceStarts(IP, NOW), "一小时以内的记录没算进去");
  });

  it("★ 按 IP 分桶 —— 别人要码要爆了不该连累我", () => {
    seedCodes(9, 0, "198.51.100.1");
    assert.equal(tooManyDeviceStarts(IP, NOW), null, "别的 IP 的配额算到了我头上");
  });

  it("★ 拿不到 IP 时**照样限流**，不是放行", () => {
    /*
     * 代码里特意删掉过一句 `if (!ip) return null`，注释写着
     * 「限流失效的方向必须是误伤，不能是没闸」。
     * 那句话哪天被人「顺手补回来」，这一条会红。
     *
     * 空 IP 现在会和所有拿不到 IP 的请求挤在同一个桶里 ——
     * 会互相挤，但不会没有闸。
     */
    seedCodes(5, 0, "");
    assert.ok(tooManyDeviceStarts("", NOW), "拿不到 IP 就不限流了");
  });
});
