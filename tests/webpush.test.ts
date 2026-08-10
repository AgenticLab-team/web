import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createPublicKey, verify as verifyRaw } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

/**
 * Web Push 协议实现的正确性与降级。
 *
 * 加密部分用 RFC 8291 附录 A 的**官方测试向量**锁死：协议实现错一个
 * 字节的症状是「推送服务收下了但用户什么都没收到」—— 没有任何报错，
 * 只有测试向量能在它上线前抓住。
 *
 * 降级部分锁的是「没配置 / 配错」都要**说出来**而不是装正常。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-webpush-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";
// 明确清掉，防止外部环境里恰好配了 VAPID 影响「未配置」分支的断言
delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;
delete process.env.VAPID_SUBJECT;

let wp: typeof import("@/lib/notifications/webpush");
let health: typeof import("@/lib/health");

before(async () => {
  wp = await import("@/lib/notifications/webpush");
  health = await import("@/lib/health");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

// ── RFC 8291 附录 A 的测试向量 ───────────────────────────────

const V = {
  plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic:
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPublic:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  header:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  ciphertext:
    "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ",
};

describe("RFC 8291 载荷加密", () => {
  it("与官方测试向量逐字节一致", () => {
    const message = wp.encryptPayload(
      wp.b64uDecode(V.plaintext),
      wp.b64uDecode(V.uaPublic),
      wp.b64uDecode(V.auth),
      { asPrivateKey: wp.b64uDecode(V.asPrivate), salt: wp.b64uDecode(V.salt) },
    );
    const expected = Buffer.concat([wp.b64uDecode(V.header), wp.b64uDecode(V.ciphertext)]);
    assert.equal(message.toString("base64url"), expected.toString("base64url"));
  });

  it("注入的私钥推出的公钥与向量一致 —— 保证向量测的是同一对密钥", () => {
    const message = wp.encryptPayload(
      wp.b64uDecode(V.plaintext),
      wp.b64uDecode(V.uaPublic),
      wp.b64uDecode(V.auth),
      { asPrivateKey: wp.b64uDecode(V.asPrivate), salt: wp.b64uDecode(V.salt) },
    );
    // 头是 salt(16) + rs(4) + idlen(1)，其后 65 字节是发送方公钥
    assert.equal(message.subarray(21, 86).toString("base64url"), V.asPublic);
  });

  it("不注入随机量时也能产出结构合法的消息", () => {
    const message = wp.encryptPayload(
      Buffer.from("hi"),
      wp.b64uDecode(V.uaPublic),
      wp.b64uDecode(V.auth),
    );
    assert.equal(message.readUInt32BE(16), 4096); // 记录大小
    assert.equal(message.readUInt8(20), 65); // keyid 长度
    // 明文 2 字节 + 定界符 1 + GCM tag 16 = 19，加 86 字节头
    assert.equal(message.length, 86 + 19);
  });

  it("拒绝不在曲线上的订阅公钥，而不是拿错误密钥加密后静默丢失", () => {
    const bogus = Buffer.alloc(65, 7);
    bogus[0] = 0x04;
    assert.throws(() =>
      wp.encryptPayload(Buffer.from("hi"), bogus, wp.b64uDecode(V.auth)),
    );
  });
});

describe("VAPID", () => {
  it("签出的 JWT 能用同一把公钥验回来，claims 正确", () => {
    const keys = wp.generateVapidKeys();
    const config = {
      publicKey: wp.b64uDecode(keys.publicKey),
      privateKey: wp.b64uDecode(keys.privateKey),
      subject: "mailto:ops@example.com",
    };
    const nowMs = 1_700_000_000_000;
    const auth = wp.vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", config, nowMs);

    const match = auth.match(/^vapid t=([^,]+), k=(.+)$/);
    assert.ok(match, "Authorization 头格式应为 vapid t=..., k=...");
    assert.equal(match[2], keys.publicKey);

    const [head, payload, sig] = match[1].split(".");
    assert.equal(JSON.parse(wp.b64uDecode(head).toString()).alg, "ES256");
    const claims = JSON.parse(wp.b64uDecode(payload).toString());
    // aud 必须是 origin，不带 path —— 带了部分推送服务直接 403
    assert.equal(claims.aud, "https://fcm.googleapis.com");
    assert.equal(claims.sub, "mailto:ops@example.com");
    assert.equal(claims.exp, Math.floor(nowMs / 1000) + 12 * 3600);

    const pub = createPublicKey({
      format: "jwk",
      key: {
        kty: "EC",
        crv: "P-256",
        x: wp.b64u(config.publicKey.subarray(1, 33)),
        y: wp.b64u(config.publicKey.subarray(33, 65)),
      },
    });
    const valid = verifyRaw(
      "sha256",
      Buffer.from(`${head}.${payload}`),
      { key: pub, dsaEncoding: "ieee-p1363" },
      wp.b64uDecode(sig),
    );
    assert.ok(valid, "签名应当验证通过");
  });
});

describe("没配置时的降级", () => {
  it("什么都没配：configProblem 给出可操作的提示", () => {
    const problem = wp.configProblem({ publicKey: "", privateKey: "", subject: "" });
    assert.ok(problem?.includes("未配置"));
  });

  it("配了一半：明说不全，不含糊", () => {
    const problem = wp.configProblem({ publicKey: "abc", privateKey: "", subject: "" });
    assert.ok(problem?.includes("不全"));
  });

  it("公私钥不配对：抓出来 —— 这是最隐蔽的坏法，每次投递都 401 而站内一切正常", () => {
    const a = wp.generateVapidKeys();
    const b = wp.generateVapidKeys();
    const problem = wp.configProblem({
      publicKey: a.publicKey,
      privateKey: b.privateKey,
      subject: "mailto:ops@example.com",
    });
    assert.ok(problem?.includes("不匹配"));
  });

  it("配置正确时没有问题可报", () => {
    const keys = wp.generateVapidKeys();
    const problem = wp.configProblem({
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      subject: "mailto:ops@example.com",
    });
    assert.equal(problem, null);
    assert.notEqual(
      wp.getWebPushConfig({
        publicKey: keys.publicKey,
        privateKey: keys.privateKey,
        subject: "mailto:ops@example.com",
      }),
      null,
    );
  });

  it("subject 格式不对也算配错", () => {
    const keys = wp.generateVapidKeys();
    const problem = wp.configProblem({
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      subject: "ops@example.com",
    });
    assert.ok(problem?.includes("mailto"));
  });

  it("**https: 的 subject 也接受** —— 线上用的就是这一种", () => {
    /*
     * 线上配的是 `VAPID_SUBJECT=https://agenticlab.sh`，
     * 而不是脚本里那个占位邮箱 —— 这个值会发给推送服务
     * （Google / Mozilla）当联系方式，放个人邮箱没必要。
     *
     * 校验里只要有人手滑把它收紧成「只认 mailto:」，
     * 线上推送第二天就全挂，而站内一切正常、没有一页会红。
     * 所以这条单独钉住。
     */
    const keys = wp.generateVapidKeys();
    assert.equal(
      wp.configProblem({
        publicKey: keys.publicKey,
        privateKey: keys.privateKey,
        subject: "https://agenticlab.sh",
      }),
      null,
    );
  });

  it("**真的跑一遍生成脚本，validator 认得它的产出**", () => {
    /*
     * `scripts/webpush-keys.ts` 开头写明「故意不 import 项目里的任何
     * 模块」—— 它要在还没配好环境的机器上能跑。代价是**密钥的编码方式
     * 在两处各写了一遍**，可以悄悄分叉。
     *
     * 分叉的表现很难查：脚本照常打印三行，人照着贴进 .env.local，
     * 然后健康检查说「配置不全」或「公私钥不匹配」，而两边看起来都没错。
     *
     * ── 第一版这条测试是假的 ──
     *
     * 它在测试里用 createECDH + base64url **重造**了一对密钥再喂给
     * validator。那测的是「我以为脚本是这么写的」，不是脚本本身：
     * 把脚本里的 base64url 改成 base64，这条测试照样全绿。
     *
     * 所以现在**真的把脚本跑起来**，解析它打印的东西。
     */
    const out = execFileSync(
      "npx",
      ["tsx", fileURLToPath(new URL("../scripts/webpush-keys.ts", import.meta.url))],
      { encoding: "utf8", timeout: 60_000 },
    );

    const keys: Record<string, string> = {};
    for (const line of out.split("\n")) {
      const m = /^(VAPID_[A-Z_]+)=(.+)$/.exec(line.trim());
      if (m) keys[m[1]] = m[2];
    }

    assert.ok(keys.VAPID_PUBLIC_KEY, "脚本没打印公钥");
    assert.ok(keys.VAPID_PRIVATE_KEY, "脚本没打印私钥");

    const problem = wp.configProblem({
      publicKey: keys.VAPID_PUBLIC_KEY,
      privateKey: keys.VAPID_PRIVATE_KEY,
      // subject 用线上那一种，顺带确认它没被脚本的占位值绑死
      subject: "https://agenticlab.sh",
    });
    assert.equal(problem, null, `脚本产出的密钥被 validator 拒了：${problem}`);
  });

  it("**脚本确实只打印这三个变量**，不多不少", () => {
    /*
     * 少一个的话，人贴完还是「配置不全」；
     * 多一个不认识的，人会以为自己漏配了什么。
     */
    const src = readFileSync(
      new URL("../scripts/webpush-keys.ts", import.meta.url),
      "utf8",
    );
    const printed = [...src.matchAll(/\b(VAPID_[A-Z_]+)=/g)].map((m) => m[1]);
    assert.deepEqual(
      [...new Set(printed)].sort(),
      ["VAPID_PRIVATE_KEY", "VAPID_PUBLIC_KEY", "VAPID_SUBJECT"],
    );
  });

  it("健康检查里「没配置」报 degraded 而不是 ok —— 缺口要一直看得见", () => {
    const report = health.probeWebPush();
    assert.equal(report.component, "web_push");
    assert.equal(report.status, "degraded");
    assert.ok(report.detail?.includes("未配置"));
  });
});
