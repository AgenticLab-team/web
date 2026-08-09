import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import {
  MIN_CODE_LOGINS,
  SNOOZE_DAYS,
  nudgeCopy,
  nudgeDecision,
  type NudgeFacts,
} from "@/lib/auth/passkey-nudge-rules";
import { passwordLoginVerdict } from "@/lib/auth/passkey-policy";
import { stripComments as strip } from "./_source";

/**
 * 「加个 Passkey 吧」——普通成员那一侧的提醒。
 *
 * ─────────────────────────────────────────
 * 站长报的是「注册完没有任何东西提醒我加 Passkey」
 * ─────────────────────────────────────────
 *
 * 而当时站里唯一和 Passkey 有关的主动动作，是**强制** ——
 * 它只作用于手里有 dangerLevel ≥ 2 权限的账号。一个刚注册的普通成员
 * 当然不在其中，所以什么都不会发生。这是设计如此，不是 bug：
 * 站长的硬约束是「只有群成员能登录」，把一个真的群成员
 * 关在门外的代价，比他少一把备用钥匙大得多。
 *
 * 缺的是**提醒**。而一条提醒最容易变成的东西，是一个消不掉的红点 ——
 * 这个项目刚修过一个同源的 bug（通知重复弹出，根因是「已读」没落库）。
 * 所以下面绝大多数断言不是在测「它会不会出现」，
 * 而是在测**它会不会消失、会不会回来**。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
/* 结构性断言一律先剥注释 —— 否则会匹配到这个功能自己写的说明文字 */

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

/** 一个「什么都满足、就该弹」的基准。每条用例只改自己关心的那一项 */
const ready = (over: Partial<NudgeFacts> = {}): NudgeFacts => ({
  hasPasskey: false,
  privileged: false,
  declinedAt: null,
  snoozedAt: null,
  codeLoginCount: MIN_CODE_LOGINS,
  now: NOW,
  ...over,
});

describe("**已经绑了的人绝对不能再看到它**", () => {
  it("基准情况下确实会弹 —— 不然下面每条「不弹」都测不出东西", () => {
    assert.deepEqual(nudgeDecision(ready()), { show: true });
  });

  it("有 Passkey 就不弹，别的条件一概不看", () => {
    /*
     * 这条排在所有判断的第一位。一个已经照做了的人被继续催着做同一件事，
     * 是最快教会他无视整块区域的做法。
     */
    assert.deepEqual(nudgeDecision(ready({ hasPasskey: true })), {
      show: false,
      reason: "has_passkey",
    });
  });

  it("哪怕他从来没表过态、又取了一百次验证码，也不弹", () => {
    assert.equal(
      nudgeDecision(ready({ hasPasskey: true, codeLoginCount: 100 })).show,
      false,
    );
  });
});

describe("**「不用了」说的是永远**", () => {
  /*
   * 一个说好了不再出现、半年后又出现的东西，
   * 比一开始就没有承诺过更伤信任。
   */
  it("说过之后就不弹了", () => {
    assert.deepEqual(nudgeDecision(ready({ declinedAt: NOW - 1000 })), {
      show: false,
      reason: "declined",
    });
  });

  it("**十年之后也不弹** —— 它没有过期时间", () => {
    assert.equal(nudgeDecision(ready({ declinedAt: NOW - 3650 * DAY })).show, false);
  });

  it("再多取几次验证码也顶不回来", () => {
    assert.equal(
      nudgeDecision(ready({ declinedAt: NOW - DAY, codeLoginCount: 999 })).show,
      false,
    );
  });

  it("「不用了」压过「以后再说」——两个都点过的人不该因为推迟到期又被提醒", () => {
    assert.deepEqual(
      nudgeDecision(ready({ declinedAt: NOW - 100 * DAY, snoozedAt: NOW - 100 * DAY })),
      { show: false, reason: "declined" },
    );
  });
});

describe("**「以后再说」是推迟，不是拒绝**", () => {
  /*
   * 只给一个「关掉」出口是不够的。没有「永远别再提」的话，
   * 用户唯一的办法是无视它 —— 而无视一个提醒会训练他无视所有提醒。
   * 反过来，只给「永远别再提」也不行：一个此刻没空的人
   * 会被迫在「永久关掉」和「继续烦」之间二选一。
   */
  it("推掉之后的第二天不弹", () => {
    assert.deepEqual(nudgeDecision(ready({ snoozedAt: NOW - DAY })), {
      show: false,
      reason: "snoozed",
    });
  });

  it(`差一天不到 ${SNOOZE_DAYS} 天，还不弹`, () => {
    assert.equal(nudgeDecision(ready({ snoozedAt: NOW - (SNOOZE_DAYS - 1) * DAY })).show, false);
  });

  it(`满 ${SNOOZE_DAYS} 天就再提一次 —— 不然「以后再说」等于「不用了」`, () => {
    assert.deepEqual(nudgeDecision(ready({ snoozedAt: NOW - SNOOZE_DAYS * DAY })), { show: true });
  });

  it("更久以前推掉的，当然也弹", () => {
    assert.equal(nudgeDecision(ready({ snoozedAt: NOW - 365 * DAY })).show, true);
  });

  it("推迟的窗口是可调的，但默认必须是有限的 —— 一个永不到期的推迟就是悄悄的拒绝", () => {
    assert.ok(SNOOZE_DAYS > 0 && Number.isFinite(SNOOZE_DAYS));
    assert.equal(
      nudgeDecision(ready({ snoozedAt: NOW - 3 * DAY, snoozeDays: 2 })).show,
      true,
    );
  });
});

describe("**刚注册完那一刻不提醒**", () => {
  /*
   * 绑定成功那一屏（/onboarding）已经摆过一次 Passkey 设置，
   * 而那是最容易被无脑关掉的时刻 —— 用户刚经历完「切到微信、加好友、
   * 填验证码、切回来」，此刻他只想进去看看这个站长什么样。
   *
   * 更根本的是他**还没有痛感**：Passkey 在这个站解决的具体问题是
   * 「不用再回微信找猫娘要验证码」，而一个只取过一次码的人，
   * 不知道这件事要重复多少遍。
   */
  it("一次都没取过码 —— 不弹", () => {
    assert.deepEqual(nudgeDecision(ready({ codeLoginCount: 0 })), {
      show: false,
      reason: "too_early",
    });
  });

  it("**只取过一次（也就是刚注册完）—— 不弹**", () => {
    assert.equal(nudgeDecision(ready({ codeLoginCount: 1 })).show, false);
  });

  it("第二次为了登录又去要了一次码 —— 这时候才说话", () => {
    assert.equal(nudgeDecision(ready({ codeLoginCount: 2 })).show, true);
    assert.equal(MIN_CODE_LOGINS, 2, "门槛改了的话上面那句「第二次」的说法也要跟着改");
  });
});

describe("**有危险级权限的人不走提醒，走强制**", () => {
  /*
   * 不是因为他不需要 Passkey —— 他是最需要的那个。
   * 而是因为他那一侧已经有一条**不可关闭**的线：/me/security 顶上的红字、
   * 密码登录直接被拒、后台设置页上的 lockoutRisk 名单。
   *
   * 在这里再提醒一遍的坏处很具体：这张卡片带着一个「不用了」按钮，
   * 而对这个账号来说这件事不是可选的。给他一个能关掉的出口，
   * 等于告诉他这事可以商量。
   */
  it("privileged 不显示这张卡片", () => {
    assert.deepEqual(nudgeDecision(ready({ privileged: true })), {
      show: false,
      reason: "privileged",
    });
  });

  it("**「不用了」一点都动不了强制那条线**", () => {
    /*
     * 这是整个功能最要紧的一条边界：提醒和强制是两套东西，
     * 而 passwordLoginVerdict 连这两列的存在都不知道。
     */
    for (const hasPasskey of [true, false]) {
      const verdict = passwordLoginVerdict({ privileged: true, hasPasskey, enforced: true });
      assert.equal(verdict.allowed, false, "有危险级权限的人还是不能用密码登录");
    }
  });

  it("普通成员照旧不受强制影响 —— 提醒这一侧改了什么都不该波及他", () => {
    assert.equal(
      passwordLoginVerdict({ privileged: false, hasPasskey: false, enforced: true }).allowed,
      true,
    );
  });

  it("**判定的入参里根本没有「表过什么态」这一项** —— 结构上就串不了台", () => {
    const policy = strip(src("lib/auth/passkey-policy.ts"));
    for (const leak of ["passkeyNudge", "declinedAt", "snoozedAt", "nudge"]) {
      assert.equal(policy.includes(leak), false, `强制那一层出现了提醒的概念：${leak}`);
    }
  });
});

describe("**「为什么值得加」要落到这个人的具体处境**", () => {
  /*
   * 「为了安全」是放到任何网站上都成立的套话，而套话会被当成装饰，
   * 被当成装饰的提醒不如没有。这个站的登录方式是
   * 「微信群验证码 + 可选的密码」，那句话就得说到这上面。
   */
  const noPassword = nudgeCopy({ hasPassword: false });
  const withPassword = nudgeCopy({ hasPassword: true });

  it("两种人说的不是同一句话", () => {
    assert.notEqual(noPassword.title, withPassword.title);
    assert.notEqual(noPassword.body, withPassword.body);
  });

  it("**没设密码的人**：要说清楚他现在只有一条路，而这条路会断", () => {
    assert.match(noPassword.body, /验证码/);
    assert.match(noPassword.body, /猫娘|风控/);
  });

  it("**设了密码的人**：不许吓唬他说会进不来 —— 那不是真的，而被吓唬过一次的人下次不会再信", () => {
    assert.equal(/进不来|登不进|被锁|锁在门外/.test(withPassword.body), false);
    // 换成说 Passkey 多给了什么：不用敲长密码，以及它认域名
    assert.match(withPassword.body, /域名|仿冒|骗/);
  });

  it("**没有一句是「为了安全」这种废话**", () => {
    for (const copy of [noPassword, withPassword]) {
      const text = copy.title + copy.body;
      assert.equal(/为了(你的)?(账号)?安全/.test(text), false, `套话：${text}`);
      // 每一句都得提到一个具体的处境，而不只是一个形容词
      assert.match(text, /验证码|密码|设备|域名|微信/);
    }
  });

  it("标题短到能在手机上一行半读完", () => {
    for (const copy of [noPassword, withPassword]) {
      assert.ok(copy.title.length <= 30, `标题太长：${copy.title}`);
      assert.ok(copy.body.length > 30, "正文没说清楚为什么");
    }
  });
});

describe("**状态必须在服务端**", () => {
  /*
   * 只存 localStorage 的话，两份状态迟早分叉 —— 而分叉那天
   * 用户看到的是一个点不掉的东西：手机上划掉了，换到电脑上它还在。
   */
  it("规则层是纯的 —— 它在登录路径上，测试要能密集地跑", () => {
    const rules = src("lib/auth/passkey-nudge-rules.ts");
    for (const forbidden of ["server-only", "@/lib/db", "drizzle-orm"]) {
      assert.equal(rules.includes(forbidden), false, `规则层引了 ${forbidden}`);
    }
  });

  it("**规则层不读时钟** —— render 期间读 Date.now() 过不了 React Compiler", () => {
    assert.equal(strip(src("lib/auth/passkey-nudge-rules.ts")).includes("Date.now"), false);
  });

  it("**组件里一个 localStorage 都没有**", () => {
    const ui = strip(src("components/passkey/PasskeyNudge.tsx"));
    for (const forbidden of ["localStorage", "sessionStorage", "document.cookie"]) {
      assert.equal(ui.includes(forbidden), false, `提醒状态存到了浏览器里：${forbidden}`);
    }
  });

  it("两个状态都写进 users 表", () => {
    const store = strip(src("lib/auth/passkey-nudge.ts"));
    assert.match(store, /passkeyNudgeSnoozedAt/);
    assert.match(store, /passkeyNudgeDeclinedAt/);
    assert.match(store, /db\s*\n?\s*\.update\(users\)|db\.update\(users\)/);
  });

  it("库里存的是时间戳不是布尔 —— 「什么时候决定的」在翻旧账时就是证据", () => {
    const schema = src("lib/db/schema/users.ts");
    assert.match(schema, /passkey_nudge_snoozed_at["`']?\s*\)/);
    assert.match(schema, /integer\("passkey_nudge_declined_at"\)/);
    assert.equal(/passkey_nudge_declined["`']?\s*,\s*\{\s*mode:\s*"boolean"/.test(schema), false);
  });

  it("**迁移是写下来了的** —— 只改 schema 不写迁移，线上那张表就没有这两列", () => {
    const sql = readFileSync(
      new URL("../drizzle/0045_passkey_nudge.sql", import.meta.url),
      "utf8",
    );
    assert.match(sql, /passkey_nudge_snoozed_at/);
    assert.match(sql, /passkey_nudge_declined_at/);

    const journal = JSON.parse(
      readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"),
    ) as { entries: { tag: string }[] };
    assert.ok(
      journal.entries.some((e) => e.tag === "0045_passkey_nudge"),
      "迁移文件改了名，但 _journal.json 里的 tag 没跟着改 —— 那条迁移不会被执行",
    );
  });
});

describe("接线", () => {
  it("**两个动作都用 getRealUser()**", () => {
    /*
     * getCurrentUser() 在预览态下是**被预览的那个人**。用它的话，
     * 管理员以某个成员的视角看首页、顺手点了「不用了」，
     * 结果是那个成员从此再收不到提醒，而他本人从没看见过这张卡片。
     */
    const actions = strip(src("lib/auth/passkey-nudge-actions.ts"));
    assert.match(actions, /getRealUser\(\)/);
    assert.equal(actions.includes("getCurrentUser"), false, "用了预览态下会变成别人的那个");
  });

  it("预览态整个拦掉", () => {
    assert.match(strip(src("lib/auth/passkey-nudge-actions.ts")), /assertNotPreviewing\(\)/);
  });

  it("**首页真的渲染了它** —— 一个没有人看得到的提醒等于没做", () => {
    const page = strip(src("app/(app)/page.tsx"));
    assert.match(page, /<PasskeyNudge/);
    assert.match(page, /passkeyNudgeFor\(/);
  });

  it("**首页也用 getRealUser 取这张卡** —— 预览别人时不该看到别人的提醒", () => {
    assert.match(strip(src("app/(app)/page.tsx")), /getRealUser\(\)/);
  });

  it("时钟在查询层读完，不在组件里", () => {
    const ui = strip(src("components/passkey/PasskeyNudge.tsx"));
    assert.equal(ui.includes("Date.now"), false, "组件里读了时钟");
  });

  it("**「过几天再说」里的天数和规则层是同一个数**", () => {
    /*
     * 抄一个字面量过去的下场很具体：用户看到「过 14 天再说」，
     * 却在第 7 天又被提醒一次。
     */
    const actions = strip(src("lib/auth/passkey-nudge-actions.ts"));
    assert.match(actions, /\$\{SNOOZE_DAYS\}/);
    assert.equal(/过 \d+ 天/.test(actions), false, "天数被写死了");
  });

  it("`use server` 的文件只导出 async 函数", () => {
    const actions = strip(src("lib/auth/passkey-nudge-actions.ts"));
    for (const match of actions.matchAll(/^export (?!type )(\w+)/gm)) {
      assert.equal(match[1], "async", `导出了一个非 async 的东西：${match[0]}`);
    }
  });
});

describe("**它是一张卡片，不是弹窗，也不是红点**", () => {
  const ui = strip(src("components/passkey/PasskeyNudge.tsx"));

  it("**不盖住整页** —— 一个用验证码照样进得来的人，不该被拦住去读一段字", () => {
    assert.equal(/fixed\s+inset-0|role="dialog"|<dialog/.test(ui), false, "做成了模态框");
  });

  it("不进通知中心、不带角标", () => {
    for (const forbidden of ["notifications", "badge", "unread"]) {
      assert.equal(ui.includes(forbidden), false, `它变成了一个红点：${forbidden}`);
    }
  });

  it("**三个出口一样大** —— 藏起来的拒绝入口等于没有", () => {
    assert.equal(
      (ui.match(/min-h-11/g) ?? []).length,
      3,
      "「现在就加」「以后再说」「不用了」应该是三个同样尺寸的按钮",
    );
    for (const label of ["现在就加", "以后再说", "不用了"]) {
      assert.ok(ui.includes(label), `少了一个出口：${label}`);
    }
  });

  it("**触摸目标够大** —— 44px 以下的按钮，拇指按下去有一半概率落空（手机端硬要求）", () => {
    // min-h-11 = 2.75rem = 44px
    assert.match(ui, /min-h-11/);
  });

  it("**当场就能加**，不是把人丢到设置页去自己找按钮", () => {
    // 一条把活儿丢回给用户的提示，做的事只是打断他
    assert.match(ui, /usePasskeyRegister/);
    assert.equal(/href="\/me\/security"/.test(ui), false, "只给了个链接，没给按钮");
  });

  it("**浏览器不支持 Passkey 时整块不出现**", () => {
    /*
     * 在一个根本弹不出指纹框的浏览器里劝人加 Passkey，
     * 用户点下去只会得到一句报错 —— 他会认为这个站是坏的。
     */
    assert.match(ui, /support === "unsupported"/);
    assert.match(ui, /support === "unknown"/);
    assert.match(ui, /return null/);
  });

  it("**「不用了」带一次撤销** —— 它是永久的，而三个按钮在手机上挨着排", () => {
    // 这个站的规矩是不弹确认框、直接执行并给撤销机会
    assert.match(ui, /undoDecline/);
    assert.match(strip(src("lib/auth/passkey-nudge-actions.ts")), /undoDeclinePasskeyNudgeAction/);
  });

  it("保存失败要把卡片放回去", () => {
    // 静默失败等于状态没存上，而下次它照样出现 —— 那就成了「点不掉的东西」
    assert.match(ui, /setDone\(false\)/);
  });
});

/* ───────────────────────────────────────────────────────────────
 * 真数据库
 * ─────────────────────────────────────────────────────────────── */

const tmp = mkdtempSync(join(tmpdir(), "al-passkey-nudge-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

let dbm: typeof import("@/lib/db");
let schema: typeof import("@/lib/db/schema");
let nudge: typeof import("@/lib/auth/passkey-nudge");
let can: typeof import("@/lib/rbac/can");
let login: typeof import("@/lib/auth/password-login");

const MEMBER = "01MEMBER00000000000000000";
const ADMIN = "01ADMIN000000000000000000";
const POWER_ROLE = "01ROLEPOWER000000000000AA";

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  nudge = await import("@/lib/auth/passkey-nudge");
  can = await import("@/lib/rbac/can");
  login = await import("@/lib/auth/password-login");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  for (const t of [
    schema.loginAttempts,
    schema.credentials,
    schema.userRoles,
    schema.rolePermissions,
    schema.roles,
    schema.users,
  ]) {
    dbm.db.delete(t).run();
  }
  can.invalidatePermissionCache();

  dbm.db
    .insert(schema.users)
    .values([
      { id: MEMBER, wxId: "member_wx", wxNickname: "普通成员", status: "active" },
      { id: ADMIN, wxId: "admin_wx", wxNickname: "管理员", status: "active" },
    ])
    .run();
});

/** 记一次验证码登录 —— 和 /api/auth/bind/status 往库里写的那条形状一致 */
const codeLogin = (userId: string, success = true) =>
  dbm.db
    .insert(schema.loginAttempts)
    .values({ userId, method: "bind_code", success })
    .run();

const givePasskey = (userId: string) =>
  dbm.db
    .insert(schema.credentials)
    .values({ userId, type: "passkey", secret: "fake-public-key" })
    .run();

const givePassword = (userId: string) =>
  dbm.db
    .insert(schema.credentials)
    .values({ userId, type: "password", secret: "fake-hash" })
    .run();

/** 给这个人一项 dangerLevel 3 的权限（system.settings），让他变成 privileged */
const makePrivileged = (userId: string) => {
  dbm.db.insert(schema.roles).values({ id: POWER_ROLE, key: "power", name: "有权限的" }).run();
  dbm.db
    .insert(schema.rolePermissions)
    .values({ roleId: POWER_ROLE, permissionKey: "system.settings", granted: true })
    .run();
  dbm.db.insert(schema.userRoles).values({ userId, roleId: POWER_ROLE }).run();
  can.invalidatePermissionCache();
};

const userRow = (id: string) =>
  dbm.db.select().from(schema.users).where(eq(schema.users.id, id)).get()!;

const cardFor = (id: string, now = NOW) => nudge.passkeyNudgeFor(userRow(id), now);

describe("从注册到看见提醒（真库）", () => {
  it("**刚注册完的人首页上什么都没有** —— 站长看到的正是这个", () => {
    codeLogin(MEMBER); // 注册那一次也会记一条
    assert.equal(cardFor(MEMBER), null);
  });

  it("**第二次回来取验证码之后，卡片出现了**", () => {
    codeLogin(MEMBER);
    codeLogin(MEMBER);
    const card = cardFor(MEMBER);
    assert.notEqual(card, null, "取过两次码还不提醒的话，这个功能等于没做");
    assert.match(card!.body, /验证码/);
  });

  it("没设密码的人看到的是「你只有一条路」那一版", () => {
    codeLogin(MEMBER);
    codeLogin(MEMBER);
    assert.match(cardFor(MEMBER)!.body, /猫娘|风控/);
  });

  it("设了密码的人看到的是另一版 —— 不吓唬他说会进不来", () => {
    codeLogin(MEMBER);
    codeLogin(MEMBER);
    givePassword(MEMBER);
    const card = cardFor(MEMBER)!;
    assert.equal(/进不来|登不进/.test(card.body), false);
    assert.match(card.body, /域名|仿冒|骗/);
  });

  it("**绑上 Passkey 之后立刻消失** —— 不用等缓存过期", () => {
    codeLogin(MEMBER);
    codeLogin(MEMBER);
    assert.notEqual(cardFor(MEMBER), null);
    givePasskey(MEMBER);
    assert.equal(cardFor(MEMBER), null);
  });
});

describe("只数验证码那条路（真库）", () => {
  /*
   * 提醒说的是「不用再回微信取验证码」。拿别的登录方式凑数的话，
   * 提醒会提早到一个说不通的时刻 —— 那个人根本没受这个罪。
   */
  it("失败的尝试不算", () => {
    codeLogin(MEMBER);
    codeLogin(MEMBER, false);
    codeLogin(MEMBER, false);
    assert.equal(nudge.codeLoginCount(MEMBER), 1);
    assert.equal(cardFor(MEMBER), null);
  });

  it("密码登录不算", () => {
    codeLogin(MEMBER);
    dbm.db
      .insert(schema.loginAttempts)
      .values({ userId: MEMBER, method: "password", success: true })
      .run();
    assert.equal(nudge.codeLoginCount(MEMBER), 1);
    assert.equal(cardFor(MEMBER), null);
  });

  it("**别人的登录次数不算到我头上**", () => {
    codeLogin(ADMIN);
    codeLogin(ADMIN);
    codeLogin(MEMBER);
    assert.equal(nudge.codeLoginCount(MEMBER), 1);
  });
});

describe("两个出口都真的落库了（真库）", () => {
  beforeEach(() => {
    codeLogin(MEMBER);
    codeLogin(MEMBER);
  });

  it("**「以后再说」写进了 users 表**，不是只在这个浏览器里", () => {
    nudge.snoozePasskeyNudge(MEMBER, NOW);
    assert.equal(userRow(MEMBER).passkeyNudgeSnoozedAt, NOW);
    // 换台设备、清了缓存也一样看不到 —— 判定读的是库
    assert.equal(cardFor(MEMBER, NOW + DAY), null);
  });

  it(`满 ${SNOOZE_DAYS} 天之后它自己回来`, () => {
    nudge.snoozePasskeyNudge(MEMBER, NOW);
    assert.equal(cardFor(MEMBER, NOW + (SNOOZE_DAYS - 1) * DAY), null);
    assert.notEqual(cardFor(MEMBER, NOW + SNOOZE_DAYS * DAY), null);
  });

  it("**推两次，数的是最近那一次** —— 留着最早那次的话，连推两回的人马上又被提醒", () => {
    nudge.snoozePasskeyNudge(MEMBER, NOW);
    const later = NOW + SNOOZE_DAYS * DAY;
    nudge.snoozePasskeyNudge(MEMBER, later);
    assert.equal(userRow(MEMBER).passkeyNudgeSnoozedAt, later);
    assert.equal(cardFor(MEMBER, later + DAY), null);
  });

  it("**「不用了」之后，一年后也不再提**", () => {
    nudge.declinePasskeyNudge(MEMBER, NOW);
    assert.equal(userRow(MEMBER).passkeyNudgeDeclinedAt, NOW);
    for (const later of [NOW + DAY, NOW + 365 * DAY, NOW + 3650 * DAY]) {
      assert.equal(cardFor(MEMBER, later), null, "说好了永远不再提，结果又回来了");
    }
  });

  it("「不用了」顺手清掉推迟状态 —— 两列同时有值会让人以为它有期限", () => {
    nudge.snoozePasskeyNudge(MEMBER, NOW);
    nudge.declinePasskeyNudge(MEMBER, NOW + DAY);
    assert.equal(userRow(MEMBER).passkeyNudgeSnoozedAt, null);
  });

  it("**撤销「不用了」之后卡片回来** —— 三个按钮在手机上挨着排，按歪一下不能没救", () => {
    nudge.declinePasskeyNudge(MEMBER, NOW);
    assert.equal(cardFor(MEMBER), null);
    nudge.undoDeclinePasskeyNudge(MEMBER, NOW);
    assert.notEqual(cardFor(MEMBER), null);
    assert.equal(userRow(MEMBER).passkeyNudgeDeclinedAt, null);
  });

  it("**表态只写在自己那一行上**", () => {
    nudge.declinePasskeyNudge(MEMBER, NOW);
    assert.equal(userRow(ADMIN).passkeyNudgeDeclinedAt, null);
  });
});

describe("**强制那条线没有被这个功能碰坏**（真库）", () => {
  it("有危险级权限的人拿不到这张卡 —— 他那边有一条不可关闭的线", () => {
    codeLogin(ADMIN);
    codeLogin(ADMIN);
    makePrivileged(ADMIN);
    assert.equal(cardFor(ADMIN), null);
  });

  it("**点过「不用了」的普通成员，哪天被授了危险权限，照样被强制挡住**", () => {
    /*
     * 这是这个功能唯一可能造成实际伤害的路径：如果「不用了」
     * 顺手把强制也关掉了，那么一个后来当上管理员的人
     * 会带着「只有一道密码」的账号继续用下去，而没有人看得出来。
     */
    codeLogin(MEMBER);
    codeLogin(MEMBER);
    nudge.declinePasskeyNudge(MEMBER, NOW);
    givePassword(MEMBER);
    makePrivileged(MEMBER);

    const verdict = passwordLoginVerdict({
      privileged: true,
      hasPasskey: login.hasPasskey(MEMBER),
      enforced: true,
    });
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.allowed === false && verdict.code, "no_passkey_bound");
  });

  it("**他也会照常出现在站长的「会锁住谁」名单里**", async () => {
    const enforcement = await import("@/lib/auth/passkey-enforcement");
    codeLogin(MEMBER);
    nudge.declinePasskeyNudge(MEMBER, NOW);
    givePassword(MEMBER);
    makePrivileged(MEMBER);

    dbm.db
      .insert(schema.settings)
      .values({ key: "auth.require_passkey_for_admin", value: "true", type: "bool" })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: "true" } })
      .run();
    const settingsStore = await import("@/lib/settings/store");
    settingsStore.invalidateSettingsCache();

    const risk = enforcement.passkeyLockoutRisk();
    assert.equal(risk.strandedCount, 1, "点过「不用了」的人从站长的名单里消失了");
    assert.deepEqual(risk.strandedNames, ["普通成员"]);
  });
});
