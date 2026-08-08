import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * Passkey 多设备与撤销的规则测试。
 *
 * 「同一个用户绑定多把钥匙」是明确需求：手机丢了要能用电脑登录。
 * 这里锁的是几条写错了不会报错、只会静默变得不安全（或不可用）的规则：
 *   - 注册第二把钥匙不会顶掉第一把
 *   - 注册选项必须排除已有凭证（否则同一把钥匙被重复注册）
 *   - 注册必须要求 discoverable（resident key）—— 登录端不传 allowCredentials，
 *     非 discoverable 的凭证会「注册成功但永远无法登录」
 *   - 撤销后的凭证不能再登录
 *   - 注册挑战值必须绑定发起的账号，不能拿别人的挑战值给自己注册
 */

const tmp = mkdtempSync(join(tmpdir(), "al-pkd-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

type PasskeyModule = typeof import("@/lib/auth/passkey");
type DbModule = typeof import("@/lib/db");
type SchemaModule = typeof import("@/lib/db/schema");

let pk: PasskeyModule;
let dbm: DbModule;
let schema: SchemaModule;

const ALICE = "01ALICE0000000000000000000";
const BOB = "01BOB000000000000000000000";

/** 直接落一条凭证记录 —— 测试里没法让真实认证器签名，注册验签走不通 */
function insertCredential(userId: string, credentialId: string) {
  dbm.db
    .insert(schema.credentials)
    .values({
      userId,
      type: "passkey",
      name: `key-${credentialId}`,
      credentialId,
      secret: Buffer.from("fake-public-key").toString("base64url"),
      counter: 0,
    })
    .run();
}

/** 拼一个只够走到「查凭证」那一步的登录响应 */
function assertionResponse(credentialId: string, challenge: string) {
  return {
    id: credentialId,
    rawId: credentialId,
    type: "public-key" as const,
    clientExtensionResults: {},
    response: {
      clientDataJSON: Buffer.from(
        JSON.stringify({ type: "webauthn.get", challenge, origin: "http://localhost:3000" }),
      ).toString("base64url"),
      authenticatorData: "",
      signature: "",
    },
  };
}

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  pk = await import("@/lib/auth/passkey");

  dbm.db
    .insert(schema.users)
    .values([
      { id: ALICE, wxId: "wxid_alice", wxNickname: "Alice", status: "active" },
      { id: BOB, wxId: "wxid_bob", wxNickname: "Bob", status: "active" },
    ])
    .run();
});

after(() => rmSync(tmp, { recursive: true, force: true }));

describe("多设备绑定", () => {
  it("**同一个用户可以持有多把钥匙**，后加的不顶掉先加的", () => {
    insertCredential(ALICE, "cred-a1");
    insertCredential(ALICE, "cred-a2");
    const list = pk.listPasskeys(ALICE);
    assert.equal(list.length, 2);
    assert.ok(pk.hasPasskey(ALICE));
  });

  it("注册选项排除已有凭证，同一把钥匙不会被重复注册", async () => {
    const options = await pk.buildRegistrationOptions(ALICE);
    const excluded = (options.excludeCredentials ?? []).map((c) => c.id);
    assert.ok(excluded.includes("cred-a1"), "已有凭证必须出现在排除列表里");
    assert.ok(excluded.includes("cred-a2"));
  });

  it("**注册必须要求 discoverable credential**", async () => {
    // 登录走的是无用户名模式（不传 allowCredentials），
    // preferred 会让不支持 resident key 的认证器注册出一把永远无法登录的钥匙
    const options = await pk.buildRegistrationOptions(ALICE);
    assert.equal(options.authenticatorSelection?.residentKey, "required");
  });

  it("注册选项里的用户名不泄露 wx_id", async () => {
    dbm.db
      .insert(schema.users)
      .values({ id: "01NONAME000000000000000000", wxId: "wxid_noname", status: "active" })
      .run();
    const options = await pk.buildRegistrationOptions("01NONAME000000000000000000");
    assert.ok(!options.user.name.includes("wxid_"), "userName 会存进用户的钥匙串，不能是 wx_id");
    assert.ok(!options.user.displayName.includes("wxid_"));
  });

  it("移除一把不影响另一把", () => {
    const [first, second] = pk.listPasskeys(ALICE);
    const result = pk.revokePasskey(ALICE, first.id, "测试移除");
    assert.equal(result.changes, 1);
    const remaining = pk.listPasskeys(ALICE);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, second.id);
  });

  it("**不能移除别人的凭证** —— 按行 id 猜中也不行", () => {
    insertCredential(BOB, "cred-b1");
    const bobKey = pk.listPasskeys(BOB)[0];
    const result = pk.revokePasskey(ALICE, bobKey.id, "越权尝试");
    assert.equal(result.changes, 0, "只按 id 不校验归属的话，任何人都能删光别人的钥匙");
    assert.equal(pk.listPasskeys(BOB).length, 1);
  });
});

describe("撤销后的凭证不能再登录", () => {
  it("撤销的凭证在登录时被拒绝，且不消耗验签", async () => {
    insertCredential(ALICE, "cred-revoked");
    const row = pk.listPasskeys(ALICE).find((c) => c.name === "key-cred-revoked");
    assert.ok(row);
    pk.revokePasskey(ALICE, row.id, "用户主动移除");

    // 挑战值合法、凭证却已撤销 —— 必须拦在验签之前
    pk.storeChallenge("chal-revoked", "authentication", null);
    const result = await pk.completeAuthentication(assertionResponse("cred-revoked", "chal-revoked"));
    assert.equal(result.ok, false);
    assert.equal(result.error, "凭证不存在或已撤销");
  });

  it("从未注册过的凭证同样被拒绝", async () => {
    pk.storeChallenge("chal-unknown", "authentication", null);
    const result = await pk.completeAuthentication(assertionResponse("cred-nobody", "chal-unknown"));
    assert.equal(result.ok, false);
    assert.equal(result.error, "凭证不存在或已撤销");
  });

  it("失败的尝试写进登录历史，用户能看到有人拿他的钥匙试过", async () => {
    const attempts = dbm.db.select().from(schema.loginAttempts).all();
    assert.ok(
      attempts.some((a) => a.method === "passkey" && !a.success),
      "失败尝试不落库的话，被撤销的钥匙被反复尝试也没人知道",
    );
  });
});

describe("注册挑战值绑定账号", () => {
  it("**拿别人的注册挑战值给自己注册必须失败**", async () => {
    // Alice 发起的注册，Bob 拿到挑战值来提交
    pk.storeChallenge("chal-alice-reg", "registration", ALICE);
    const response = {
      id: "cred-hijack",
      rawId: "cred-hijack",
      type: "public-key" as const,
      clientExtensionResults: {},
      response: {
        clientDataJSON: Buffer.from(
          JSON.stringify({
            type: "webauthn.create",
            challenge: "chal-alice-reg",
            origin: "http://localhost:3000",
          }),
        ).toString("base64url"),
        attestationObject: "",
      },
    };
    const result = await pk.completeRegistration(BOB, response);
    assert.equal(result.ok, false);
    assert.equal(result.error, "挑战值与当前账号不匹配");
  });

  it("挑战值被冒用尝试消费后，本人也不能再用 —— 一次性不打折扣", async () => {
    const again = pk.consumeChallenge("chal-alice-reg", "registration");
    assert.equal(again, null, "上一步的失败尝试已经消费了挑战值，重放窗口必须关死");
  });
});
