import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { UNKNOWN_IP } from "@/lib/request";

/**
 * Passkey 的安全规则测试。
 *
 * 没法在测试里跑真实的认证器签名，但两条最关键的规则是纯逻辑，
 * 而且都是「写错了不会报错、只会静默变得不安全」的那种：
 *   1. 挑战值必须一次性 —— 能复用就是重放攻击的入口
 *   2. 计数器倒退判定 —— 判松了放过克隆凭证，判严了把 iPhone 用户全挡在门外
 */

const tmp = mkdtempSync(join(tmpdir(), "al-pk-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

type PasskeyModule = typeof import("@/lib/auth/passkey");
type DevicesModule = typeof import("@/lib/auth/devices");
type DbModule = typeof import("@/lib/db");
type SchemaModule = typeof import("@/lib/db/schema");
type RateModule = typeof import("@/lib/auth/ratelimit");

let pk: PasskeyModule;
let devices: DevicesModule;
let dbm: DbModule;
let schema: SchemaModule;
let rate: RateModule;

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  const { seedDatabase } = await import("@/lib/db/seed");
  seedDatabase();
  pk = await import("@/lib/auth/passkey");
  devices = await import("@/lib/auth/devices");
  rate = await import("@/lib/auth/ratelimit");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

describe("WebAuthn 挑战值", () => {
  it("存进去能取出来，并带上关联用户", () => {
    pk.storeChallenge("chal-1", "registration", "user-1");
    const result = pk.consumeChallenge("chal-1", "registration");
    assert.deepEqual(result, { userId: "user-1" });
  });

  it("**只能消费一次** —— 第二次必须失败", () => {
    pk.storeChallenge("chal-2", "authentication", null);
    assert.ok(pk.consumeChallenge("chal-2", "authentication"), "第一次应成功");
    assert.equal(
      pk.consumeChallenge("chal-2", "authentication"),
      null,
      "同一个挑战值被用第二次就是重放攻击的入口",
    );
  });

  it("类型不匹配取不出来", () => {
    pk.storeChallenge("chal-3", "registration", "user-1");
    assert.equal(
      pk.consumeChallenge("chal-3", "authentication"),
      null,
      "注册用的挑战值不能拿来登录",
    );
    // 换回正确类型仍然可用，说明上一步没有误消费
    assert.ok(pk.consumeChallenge("chal-3", "registration"));
  });

  it("不存在的挑战值返回 null", () => {
    assert.equal(pk.consumeChallenge("never-issued", "authentication"), null);
  });

  it("过期的挑战值取不出来", () => {
    dbm.db
      .insert(schema.webauthnChallenges)
      .values({
        challenge: "chal-expired",
        kind: "authentication",
        expiresAt: Date.now() - 1000,
      })
      .run();
    assert.equal(pk.consumeChallenge("chal-expired", "authentication"), null);
  });

  it("存新挑战值时会清掉过期的，表不会无限增长", () => {
    dbm.db
      .insert(schema.webauthnChallenges)
      .values({ challenge: "old-1", kind: "authentication", expiresAt: Date.now() - 10_000 })
      .run();
    pk.storeChallenge("chal-4", "authentication", null);
    const leftover = dbm.db
      .select()
      .from(schema.webauthnChallenges)
      .all()
      .filter((r) => r.challenge === "old-1");
    assert.equal(leftover.length, 0);
  });
});

describe("凭证克隆检测", () => {
  it("计数器前进是正常的", () => {
    assert.equal(pk.isClonedCredential(5, 6), false);
    assert.equal(pk.isClonedCredential(5, 100), false);
  });

  it("计数器倒退判为克隆", () => {
    assert.equal(pk.isClonedCredential(10, 3), true);
  });

  it("计数器原地不动也判为克隆", () => {
    // 正品每用一次必然加一，用了却没变说明不是同一把
    assert.equal(pk.isClonedCredential(10, 10), true);
  });

  it("**存量计数器为 0 时永远不判克隆**", () => {
    // iCloud 钥匙串等平台认证器根本不实现计数器，一律返回 0。
    // 把这种情况当成克隆会把绝大多数 iPhone 用户挡在门外
    assert.equal(pk.isClonedCredential(0, 0), false);
    assert.equal(pk.isClonedCredential(0, 5), false);
  });
});

describe("clientDataJSON 解析", () => {
  it("能取出挑战值", () => {
    const payload = Buffer.from(
      JSON.stringify({ type: "webauthn.get", challenge: "abc123", origin: "https://x" }),
    ).toString("base64url");
    assert.equal(pk.extractChallenge(payload), "abc123");
  });

  it("畸形输入返回 null 而不是抛错", () => {
    // 这个值完全由客户端提供，不能假设它是合法的
    assert.equal(pk.extractChallenge("not-base64!!!"), null);
    assert.equal(pk.extractChallenge(Buffer.from("{bad json").toString("base64url")), null);
    assert.equal(pk.extractChallenge(Buffer.from('{"challenge":123}').toString("base64url")), null);
  });
});

describe("设备识别", () => {
  it("认得出常见平台与浏览器", () => {
    assert.equal(
      devices.describeDevice(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      ),
      "iPhone · Safari",
    );
    assert.equal(
      devices.describeDevice(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      ),
      "Mac · Chrome",
    );
  });

  it("Edge 不会被误判成 Chrome", () => {
    // Edge 的 UA 里同时含 Chrome 和 Edg，判断顺序错了就全是 Chrome
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Edg/120.0";
    assert.equal(devices.describeDevice(ua), "Windows · Edge");
  });

  it("认不出就如实说未知，不瞎猜", () => {
    assert.equal(devices.describeDevice(null), "未知设备");
    assert.equal(devices.describeDevice("curl/8.0"), "未知设备");
  });
});

describe("登录限流", () => {
  it("**拿不到 IP 时照样限流** —— 失效方向必须是误伤，不是没闸", () => {
    /*
     * 这条原来断言的是相反的（「没有 IP 时不限流」）。
     * 那是个失效开着的口子：哪天前面换个反向代理、或者有人
     * 直连 node 的端口，全站按 IP 的限流会一起消失，
     * 而没有任何地方会报错。
     *
     * 现在 `clientIp()` 保证有值，拿不到时是 `UNKNOWN_IP` 哨兵，
     * 这类请求挤在同一个桶里 —— 会互相挤，但不会没有闸。
     */
    for (let i = 0; i < 25; i++) {
      dbm.db
        .insert(schema.loginAttempts)
        .values({ method: "passkey", success: false, ip: UNKNOWN_IP })
        .run();
    }
    assert.ok(rate.tooManyLoginAttempts(UNKNOWN_IP), "哨兵桶没有被限流");
  });

  it("失败次数未到阈值不限流", () => {
    for (let i = 0; i < 3; i++) {
      dbm.db
        .insert(schema.loginAttempts)
        .values({ method: "passkey", success: false, ip: "1.2.3.4" })
        .run();
    }
    assert.equal(rate.tooManyLoginAttempts("1.2.3.4"), null);
  });

  it("超过阈值后限流", () => {
    for (let i = 0; i < 25; i++) {
      dbm.db
        .insert(schema.loginAttempts)
        .values({ method: "passkey", success: false, ip: "5.6.7.8" })
        .run();
    }
    const verdict = rate.tooManyLoginAttempts("5.6.7.8");
    assert.ok(verdict, "应该被限流");
    assert.ok(verdict.retryAfterSeconds > 0);
  });

  it("成功的登录不消耗配额", () => {
    for (let i = 0; i < 50; i++) {
      dbm.db
        .insert(schema.loginAttempts)
        .values({ method: "passkey", success: true, ip: "9.9.9.9" })
        .run();
    }
    assert.equal(
      rate.tooManyLoginAttempts("9.9.9.9"),
      null,
      "登录成功五十次不该把自己锁在门外",
    );
  });
});
