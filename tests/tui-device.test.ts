import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DANGEROUS_SCOPES, SCOPE_KEYS } from "@/lib/api-tokens/rules";
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  MAX_POLL_INTERVAL_SECONDS,
  allowedScopes,
  describeDevice,
  explainBadCode,
  formatUserCode,
  nextPollInterval,
  normalizeUserCode,
  offerableScopes,
  pollOutcome,
  sanitizeFingerprint,
  tokenNameFor,
  tokenTtlMs,
} from "@/lib/tui/device-rules";
import { readCode } from "./_source";

/**
 * 设备码登录。
 *
 * ═════════════════════════════════════════
 * 这份测试盯的第一件事：**它不发账号**
 * ═════════════════════════════════════════
 *
 * 这个站唯一的门是微信群。设备码是在那扇门旁边开的一个窗口 ——
 * 它把「以某个**已有**成员的身份调 API」交给一台机器。
 *
 * 如果这条被绕过去，等于把整个站对全世界开放，
 * 而且没有任何外部症状：站长自己点一下是能进的。
 *
 * `docs/OAUTH-PROVIDER.md` 第八节对 OAuth 钉的是同一条，
 * 这里照它的做法逐条钉死。
 */

describe("**这条路径上不发账号、不发会话**", () => {
  for (const f of [
    "app/api/v1/auth/device/start/route.ts",
    "app/api/v1/auth/device/poll/route.ts",
    "lib/tui/device.ts",
    "lib/tui/device-actions.ts",
  ]) {
    it(f, () => {
      /*
       * 读**剥掉注释**的版本 —— 解释这条规矩的注释里必然写着
       * `createSession` 这几个字，按原文搜的话第一个红的是它自己。
       * （这个仓库在这一节里踩到过三次，见 tests/_source.ts。）
       */
      const body = readCode(f);
      assert.equal(body.includes("createSession"), false, "发会话了");
      assert.equal(/insert\(\s*users\s*\)/.test(body), false, "建账号了");
      assert.equal(body.includes("setSessionCookie"), false, "写会话 cookie 了");
    });
  }

  it("**同意那一步取的是 `getRealUser()`**", () => {
    /*
     * 不是 `getCurrentUser()` —— 后者在预览态下返回被预览的那个人。
     * 用错的后果是：管理员在预览某个成员时点了同意，
     * 令牌发给了那个成员，而他自己的终端永远等不到。
     *
     * 这个坑在这个仓库里已经踩过三次（GitHub 绑定、数据导出、图床上传）。
     */
    const body = readCode("lib/tui/device-actions.ts");
    assert.match(body, /getRealUser\(\)/);
    assert.equal(body.includes("getCurrentUser("), false, "用了会被预览态偏移的那个");
  });
});

describe("用户码：它要被人念出来、在手机上敲进去", () => {
  it("**字母表里没有 O I L 0 1**", () => {
    /*
     * 它们在等宽字体里几乎一样，而这串码的使用方式恰恰是
     * 「盯着终端念、在手机上敲」。
     *
     * 留着它们的后果不是「偶尔输错」—— 是输错的人会认为
     * 「这个登录坏了」，而不是「我看错了一个字符」。他不会再试第二次。
     */
    for (const c of "OIL01") {
      assert.equal(CODE_ALPHABET.includes(c), false, `字母表里还有 ${c}`);
    }
  });

  it("熵够用 —— 配合 10 分钟过期和尝试上限", () => {
    const bits = Math.log2(CODE_ALPHABET.length) * CODE_LENGTH;
    assert.ok(bits > 35, `只有 ${bits.toFixed(1)} 位熵`);
  });

  it("显示时从正中间断开，好念也好核对", () => {
    assert.equal(formatUserCode("WXYZ7Q2M"), "WXYZ-7Q2M");
  });

  it("**大小写、连字符、空格、粘贴带来的空白全部抹平**", () => {
    /*
     * 不抹的话，一个粘贴过来的码会因为一个看不见的字符被拒，
     * 而人在屏幕上看到的两串字符一模一样 —— 最难自我诊断的一种失败。
     */
    assert.equal(normalizeUserCode("wxyz-7q2m"), "WXYZ7Q2M");
    assert.equal(normalizeUserCode("  WXYZ 7Q2M  "), "WXYZ7Q2M");
    assert.equal(normalizeUserCode("WXYZ_7Q2M"), "WXYZ7Q2M");
  });

  it("长度不对、字符不对，一律拒绝", () => {
    assert.equal(normalizeUserCode("WXYZ7Q2"), null);
    assert.equal(normalizeUserCode("WXYZ7Q2MM"), null);
    assert.equal(normalizeUserCode(42), null);
  });

  it("**看错的字符要指名道姓，而不是猜一个纠回去**", () => {
    /*
     * 猜（`O → Q`？`1 → 7`？）是有歧义的，而猜错的下场比拒绝更坏：
     * 他拿到一句「码不对」，但他明明照着屏幕一个字符一个字符敲的，
     * 于是他会怀疑那串码本身，重来一遍，再错一次。
     */
    const msg = explainBadCode("WXYZ7O2M");
    assert.ok(msg?.includes("第 6 位"), msg ?? "没说是第几位");
    assert.ok(msg?.includes("O"), "没说是哪个字符");
  });

  it("位数不对也说得出差几位", () => {
    assert.match(explainBadCode("WXYZ") ?? "", /8 位.*4 位/);
  });

  it("对的码不报错", () => {
    assert.equal(explainBadCode("WXYZ-7Q2M"), null);
  });
});

describe("**SSH 网关上不许申请高危 scope**", () => {
  /*
   * 网关是一台**公开可连、而且持有他人令牌**的机器。
   * 在它上面默认打开「往一千六百人的群里发消息」，
   * 等于把那条风险乘以在线人数。
   *
   * 而且是**根本不在可申请列表里**，不是「默认不勾」——
   * 默认不勾的东西迟早会被某个版本的界面默认勾上。
   */
  it("cli 能申请全部", () => {
    assert.deepEqual([...offerableScopes("cli")].sort(), [...SCOPE_KEYS].sort());
  });

  it("ssh 拿不到危险级 ≥2 的那些", () => {
    const offered = offerableScopes("ssh");
    for (const k of DANGEROUS_SCOPES) {
      assert.equal(offered.includes(k), false, `SSH 那侧还能申请 ${k}`);
    }
    assert.ok(offered.includes("groups:read"), "把该给的也一起挡掉了");
  });

  it("**申请里带了不许的，丢掉而不是整次失败**", () => {
    /*
     * 报错会让整次登录失败，而人看到的是「登录失败」四个字 ——
     * 他不可能推断出是某一项权限的问题。少给一项的话，
     * 他会在真正用到那个功能时看到一句准确的解释。
     */
    const got = allowedScopes(["me:read", "groups:send"], "ssh");
    assert.deepEqual(got, ["me:read"]);
  });

  it("认不出的一律丢掉", () => {
    assert.deepEqual(allowedScopes(["me:read", "不存在的", 42], "cli"), ["me:read"]);
    assert.deepEqual(allowedScopes("不是数组", "cli"), []);
  });
});

describe("令牌有效期与命名", () => {
  it("**SSH 那把短得多** —— 它的明文躺在一台公开可连的机器上", () => {
    assert.ok(tokenTtlMs("ssh") < tokenTtlMs("cli"));
    assert.equal(tokenTtlMs("ssh"), 7 * 24 * 3600_000);
  });

  it("名字要能一眼答出「这把是哪台机器上的」", () => {
    assert.match(tokenNameFor("ssh", "mbp · darwin"), /SSH 网关/);
    assert.match(tokenNameFor("cli", "mbp · darwin"), /终端/);
  });

  it("换行会被抹掉 —— 名字会显示在列表里，不能让它换行", () => {
    assert.equal(tokenNameFor("cli", "a\nb").includes("\n"), false);
  });
});

describe("轮询", () => {
  const base = { expiresAt: 10_000, lastPolledAt: null, interval: 5, now: 0 } as const;

  it("还没批 → pending", () => {
    assert.equal(pollOutcome({ ...base, status: "pending" }).state, "pending");
  });

  it("拒了 → denied，而不是「过期」", () => {
    /*
     * 删行的话终端只能显示成「过期了」，而人刚刚明确点了拒绝 ——
     * 他会以为自己点错了地方然后再来一次。
     */
    assert.equal(pollOutcome({ ...base, status: "denied" }).state, "denied");
  });

  it("**已经同意了就发令牌，哪怕已经过了期**", () => {
    /*
     * 一个人在最后一秒点了同意，而终端下一次轮询落在过期之后 ——
     * 5 秒间隔下这是常事。先判过期的话他会看到「码已过期」，
     * 而他明明刚刚点了同意，屏幕上还留着那一页。
     *
     * 安全上不亏：同意这个动作本身发生在有效期内。
     */
    assert.equal(
      pollOutcome({ ...base, status: "approved", now: 999_999 }).state,
      "granted",
    );
  });

  it("没决定就过期了 → expired", () => {
    assert.equal(pollOutcome({ ...base, status: "pending", now: 999_999 }).state, "expired");
  });

  it("问得太快 → slow_down，并给一个更长的间隔", () => {
    const out = pollOutcome({ ...base, status: "pending", lastPolledAt: 0, now: 1000 });
    assert.equal(out.state, "slow_down");
    assert.equal(out.state === "slow_down" && out.interval, 10);
  });

  it("**守规矩的客户端不该被推慢** —— 留了余量给网络抖动", () => {
    /*
     * 卡得死死的话，一个完全按 5 秒睡的客户端会因为偶尔早到几十毫秒
     * 被随机推到 10 秒、20 秒，最后慢到人以为它卡住了。
     */
    const out = pollOutcome({ ...base, status: "pending", lastPolledAt: 0, now: 4_800 });
    assert.equal(out.state, "pending");
  });

  it("间隔翻倍但有上限 —— 没有上限的话，同意之后要等好几分钟才生效", () => {
    assert.equal(nextPollInterval(20), MAX_POLL_INTERVAL_SECONDS);
    assert.equal(nextPollInterval(MAX_POLL_INTERVAL_SECONDS), MAX_POLL_INTERVAL_SECONDS);
  });
});

describe("设备指纹：确认页上唯一能让人发现不对劲的东西", () => {
  it("显示的是**人认得出的东西**，不是一串 id", () => {
    /*
     * 显示设备 id 等于没显示 —— 没有人知道自己的设备 id 是什么，
     * 于是每个人都会直接点同意，包括被骗的那一个。
     */
    assert.equal(describeDevice({ host: "mbp", os: "darwin", term: "xterm" }), "mbp · darwin · xterm");
  });

  it("什么都没报上来也要说得出话", () => {
    assert.match(describeDevice({}), /设备/);
  });

  it("**客户端报的一律当不可信字符串处理**", () => {
    const fp = sanitizeFingerprint({ host: "a\nb\tc", term: 42, os: "x".repeat(200) });
    assert.equal(fp.host.includes("\n"), false);
    assert.equal(fp.term, "", "非字符串没被丢掉");
    assert.ok(fp.os.length <= 40, "没截断");
  });
});
