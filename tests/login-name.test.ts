import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  IDENTIFIER_LABEL,
  MAX_USERNAME,
  MIN_USERNAME,
  RESERVED_USERNAMES,
  identifierKind,
  normalizeIdentifier,
  phoneShape,
  usernameShape,
} from "@/lib/auth/login-name";

/**
 * 登录名与手机号。
 *
 * ─────────────────────────────────────────
 * 起因：微信 ID 记不住
 * ─────────────────────────────────────────
 *
 * 密码登录一直只收微信 ID，而真实的微信 ID 长这样：
 * `wxid_examplemember01` —— 系统分配、绝大多数人从来没见过。
 * 一条只有背得下这串号的人才走得通的**兜底**通道，
 * 等于没有这条通道：主路不通的时候，备用钥匙上刻着谁也记不住的号。
 *
 * ─────────────────────────────────────────
 * 加登录名会带进来两类新风险
 * ─────────────────────────────────────────
 *
 * **一、抢标识。** 生产库里的微信 ID 基本都是自设 ID
 * （`a12345678`、`bhjynhnyj`），和登录名长得一模一样 ——
 * 不挡的话可以把自己的登录名设成别人的微信 ID。
 *
 * **二、枚举成员。** 一个「这个登录名有人用了吗」的接口，
 * 因为占用来源里包含所有人的微信 ID，就是一个社群成员枚举器。
 * 而**群成员名单是隐私**。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

describe("登录名的格式", () => {
  it("正常的过，并且存小写", () => {
    const r = usernameShape("ZhangSan");
    assert.equal(r.ok && r.username, "zhangsan");
  });

  it("中文能用 —— 这个站的人本来就用中文名", () => {
    /*
     * 只放行 ASCII 等于让大部分人起不出一个自己记得住的名字，
     * 而记得住正是这件事的全部意义。
     */
    assert.equal(usernameShape("张三的账号").ok, true);
  });

  it("**大小写统一** —— 不统一的话 Admin 和 admin 是两个长得一样的账号", () => {
    const a = usernameShape("MyName");
    const b = usernameShape("myname");
    assert.equal(a.ok && a.username, b.ok && b.username);
  });

  it("太短太长都拒", () => {
    assert.equal(usernameShape("a".repeat(MIN_USERNAME - 1)).ok, false);
    assert.equal(usernameShape("a".repeat(MAX_USERNAME + 1)).ok, false);
  });

  it("奇怪字符拒 —— 空格、@、斜杠、零宽字符", () => {
    for (const bad of ["zhang san", "a@b", "a/b", "a​b", "a.b", "<script>"]) {
      assert.equal(usernameShape(bad).ok, false, `${JSON.stringify(bad)} 竟然过了`);
    }
  });

  it("首尾的下划线连字符拒 —— `_admin` 和 `admin` 在列表里几乎看不出差别", () => {
    for (const bad of ["_abc", "abc_", "-abc", "abc-"]) {
      assert.equal(usernameShape(bad).ok, false, `${bad} 竟然过了`);
    }
  });

  it("**纯数字拒** —— 会和手机号抢同一个输入框", () => {
    const r = usernameShape("13800138000");
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /手机号/);
  });

  it("**wxid_ 开头拒** —— 那是微信 ID 的形状，放行等于允许去占位置", () => {
    assert.equal(usernameShape("wxid_abc123").ok, false);
  });
});

describe("**保留词是给冒充留的门**", () => {
  it("挡住 admin / 官方 / 客服 这类", () => {
    /*
     * 一个把登录名设成「管理员」的人，在任何显示登录名的地方
     * 都自带一层可信度。这类冒充不需要任何技术手段，只需要没人挡。
     */
    for (const word of ["admin", "官方", "客服", "系统", "站长", "版主"]) {
      assert.equal(usernameShape(word).ok, false, `${word} 竟然能用`);
    }
  });

  it("**前缀匹配，不是精确匹配** —— 「管理员001」和「管理员」一样好用", () => {
    assert.equal(usernameShape("admin001").ok, false);
    assert.equal(usernameShape("管理员001").ok, false);
    assert.equal(usernameShape("官方助手").ok, false);
  });

  it("大写写法也挡得住 —— 先转小写再比", () => {
    assert.equal(usernameShape("ADMIN").ok, false);
    assert.equal(usernameShape("Admin123").ok, false);
  });

  it("保留词表里有中文也有英文 —— 只挡一边等于没挡", () => {
    assert.ok(RESERVED_USERNAMES.some((w) => /^[a-z]+$/.test(w)));
    assert.ok(RESERVED_USERNAMES.some((w) => /[一-龥]/.test(w)));
  });

  it("正常的名字不会被误伤", () => {
    for (const ok of ["zhangsan", "码农小王", "dev-tools", "kk_2024"]) {
      assert.equal(usernameShape(ok).ok, true, `${ok} 被误伤了`);
    }
  });
});

describe("手机号", () => {
  it("11 位大陆号过", () => {
    const r = phoneShape("13800138000");
    assert.equal(r.ok && r.phone, "13800138000");
  });

  it("空格和连字符去掉 —— 人手打的时候会带", () => {
    const r = phoneShape("138 0013-8000");
    assert.equal(r.ok && r.phone, "13800138000");
  });

  it("形状不对拒", () => {
    for (const bad of ["", "12345", "23800138000", "1380013800", "138001380000", "abcdefghijk"]) {
      assert.equal(phoneShape(bad).ok, false, `${bad} 竟然过了`);
    }
  });

  it("**说清楚它没验证过** —— 不写的话人会按别处的经验指望它能找回账号", () => {
    const ui = src("components/auth/LoginNameSetup.tsx");
    assert.match(ui, /没有经过短信验证/);
    assert.match(ui, /不能用来找回账号/);
  });

  it("**没有任何一条用手机号找回/重置的路** —— 未验证的号码能重置密码就是「填别人的号接管账号」", () => {
    const actions = strip(src("lib/auth/identity-actions.ts"));
    for (const forbidden = "reset" as const; ; ) {
      assert.doesNotMatch(actions, new RegExp(forbidden, "i"));
      break;
    }
    // 全站也不该有按手机号发验证码 / 重置的入口
    const password = strip(src("lib/auth/password-actions.ts"));
    assert.doesNotMatch(password, /users\.phone/);
  });

  it("**手机号不能拿来搜人** —— 否则这个站成了「手机号 → 这个人是谁」的反查工具", () => {
    const admin = strip(src("lib/admin/users.ts"));
    assert.doesNotMatch(admin, /like\(users\.phone/);
    assert.match(admin, /like\(users\.username/, "登录名倒是该能搜");
  });

  it("审计里只记「改过」，不记号码本身", () => {
    /*
     * 审计日志后台能翻，把号码写进去等于开了第二个副本，
     * 而那个副本不在任何「删掉我的手机号」能碰到的地方。
     */
    const actions = strip(src("lib/auth/identity-actions.ts"));
    const fn = actions.slice(actions.indexOf("function setPhone"));
    assert.doesNotMatch(fn.slice(0, 800), /after: \{ phone/);
    assert.match(fn.slice(0, 800), /after: \{ set: true \}/);
  });

  it("自己看也打码 —— 这一页会在别人看得见屏幕的地方打开", () => {
    assert.match(src("components/auth/LoginNameSetup.tsx"), /function maskPhone/);
  });
});

describe("归一化", () => {
  it("登录名和邮箱转小写，手机号去空格", () => {
    assert.equal(normalizeIdentifier("  ZhangSan "), "zhangsan");
    assert.equal(normalizeIdentifier("A@B.com"), "a@b.com");
    assert.equal(normalizeIdentifier("138 0013-8000"), "13800138000");
  });

  it("**微信 ID 也转小写** —— 手打时大写一个字母就说「密码错误」，没人会来报告", () => {
    assert.equal(normalizeIdentifier("Wxid_ABC"), "wxid_abc");
    // 对应查询那边必须用 lower(列)
    assert.match(src("lib/auth/identity.ts"), /lower\(\$\{users\.wxId\}\)/);
  });

  it("类型判断只影响提示文案，判断错了也放行不了任何人", () => {
    assert.equal(identifierKind("13800138000"), "phone");
    assert.equal(identifierKind("a@b.com"), "email");
    assert.equal(identifierKind("wxid_abc"), "wxid");
    assert.equal(identifierKind("zhangsan"), "username");
    // 自设微信 ID 和登录名分不开 —— 所以查询是四列一起查
    assert.equal(identifierKind("a12345678"), "username");
  });
});

/* ───────────────────────────────────────────────────────────────
 * 下面这一组要真数据库：抢标识和枚举都只在有别人存在时才成立
 * ─────────────────────────────────────────────────────────────── */

const tmp = mkdtempSync(join(tmpdir(), "al-loginname-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

let dbm: typeof import("@/lib/db");
let schema: typeof import("@/lib/db/schema");
let identity: typeof import("@/lib/auth/identity");

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  identity = await import("@/lib/auth/identity");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  dbm.db.delete(schema.users).run();
});

function user(over: Partial<typeof schema.users.$inferInsert> & { id: string }) {
  dbm.db.insert(schema.users).values({ status: "active", ...over }).run();
}

describe("**找人：四列一起查**", () => {
  it("微信 ID、登录名、手机号、邮箱都能找到同一个人", () => {
    user({ id: "u1", wxId: "a12345678", username: "zhangsan", phone: "13800138000", email: "z@e.com" });

    for (const input of ["a12345678", "zhangsan", "13800138000", "z@e.com"]) {
      assert.equal(identity.resolveIdentity(input)?.userId, "u1", `${input} 没找到`);
    }
  });

  it("大小写和空格无所谓", () => {
    user({ id: "u1", wxId: "a12345678", username: "zhangsan" });
    assert.equal(identity.resolveIdentity("  ZhangSan  ")?.userId, "u1");
    assert.equal(identity.resolveIdentity("A12345678")?.userId, "u1");
  });

  it("找不到就是找不到 —— 不区分原因", () => {
    assert.equal(identity.resolveIdentity("nobody"), null);
    assert.equal(identity.resolveIdentity(""), null);
    assert.equal(identity.resolveIdentity("   "), null);
  });

  it("记下是靠哪一列找到的 —— 出问题时才看得出走的哪条路", () => {
    user({ id: "u1", wxId: "a12345678", username: "zhangsan" });
    assert.equal(identity.resolveIdentity("a12345678")?.via, "wxid");
    assert.equal(identity.resolveIdentity("zhangsan")?.via, "username");
  });
});

describe("**抢标识**", () => {
  it("不能把登录名设成别人的微信 ID", () => {
    user({ id: "victim", wxId: "a12345678" });
    user({ id: "attacker", wxId: "wx_attacker" });

    const r = identity.checkUsernameAvailable("attacker", "a12345678");
    assert.equal(r.ok, false);
  });

  it("不能设成别人的邮箱、也不能和别人的登录名重名", () => {
    user({ id: "victim", wxId: "wx_v", username: "zhangsan", email: "z@e.com" });
    user({ id: "me", wxId: "wx_me" });

    assert.equal(identity.checkUsernameAvailable("me", "zhangsan").ok, false);
    // 邮箱形状本来就过不了 usernameShape，这里确认第二道也在
    assert.equal(identity.checkUsernameAvailable("me", "z@e.com").ok, false);
  });

  it("**拒绝的措辞不说被谁占了** —— 说了就等于确认那个微信 ID 在这个社群里", () => {
    user({ id: "victim", wxId: "a12345678", siteNickname: "张三" });
    user({ id: "me", wxId: "wx_me" });

    const r = identity.checkUsernameAvailable("me", "a12345678");
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.doesNotMatch(r.reason, /张三|微信|成员|a12345678/);
  });

  it("改成自己已经在用的那个不算被占", () => {
    user({ id: "me", wxId: "wx_me", username: "zhangsan" });
    assert.equal(identity.checkUsernameAvailable("me", "zhangsan").ok, true);
  });

  it("手机号被别人绑了就不给绑", () => {
    user({ id: "victim", wxId: "wx_v", phone: "13800138000" });
    user({ id: "me", wxId: "wx_me" });
    assert.equal(identity.checkPhoneAvailable("me", "13800138000").ok, false);
    assert.equal(identity.checkPhoneAvailable("me", "13900139000").ok, true);
  });
});

describe("**撞车了谁赢：微信 ID**", () => {
  /*
   * 设的时候挡得住「去占别人的微信 ID」，挡不住**之后**才进群的人
   * 恰好用这个字符串当微信 ID。那时候同一个输入匹配到两行。
   */
  it("微信 ID 排第一 —— 一个自选的标识不该盖过一个验证过的标识", () => {
    user({ id: "early", wxId: "wx_early", username: "abcdef" });
    user({ id: "late", wxId: "abcdef" }); // 后来进群的人，微信 ID 恰好撞上

    const r = identity.resolveIdentity("abcdef");
    assert.equal(r?.userId, "late");
    assert.equal(r?.via, "wxid");
  });

  it("**不是「一起拒」** —— 那会让一个新人进群同时把两个人挡在外面", () => {
    user({ id: "early", wxId: "wx_early", username: "abcdef" });
    user({ id: "late", wxId: "abcdef" });
    assert.notEqual(identity.resolveIdentity("abcdef"), null, "两个人一起进不来了");
  });

  it("被盖住的人还能用自己的微信 ID 进来", () => {
    user({ id: "early", wxId: "wx_early", username: "abcdef" });
    user({ id: "late", wxId: "abcdef" });
    assert.equal(identity.resolveIdentity("wx_early")?.userId, "early");
  });

  it("**这种情况数得出来** —— 当事人只会发现「密码突然不对了」，没人告诉他", () => {
    user({ id: "early", wxId: "wx_early", username: "abcdef" });
    user({ id: "late", wxId: "abcdef" });

    const shadowed = identity.shadowedUsernames();
    assert.deepEqual(shadowed, [{ userId: "early", username: "abcdef" }]);
  });

  it("没撞车时是空的", () => {
    user({ id: "u1", wxId: "wx1", username: "zhangsan" });
    assert.deepEqual(identity.shadowedUsernames(), []);
  });
});

describe("**不能变成社群成员枚举器**", () => {
  it("可用性检查要先登录", () => {
    /*
     * 一个不需要登录的可用性接口，对每个字符串回答「有没有人用了」——
     * 而占用来源里包含所有人的微信 ID。
     */
    const actions = strip(src("lib/auth/identity-actions.ts"));
    const fn = actions.slice(actions.indexOf("function checkUsername"));
    assert.match(fn.slice(0, 300), /getCurrentUser\(\)/);
    assert.match(fn.slice(0, 300), /if \(!user\) return fail/);
  });

  it("**不在每次按键时查** —— 那会把它变成一个按键频率的接口", () => {
    const ui = src("components/auth/LoginNameSetup.tsx");
    assert.match(ui, /onBlur=\{\(\) => \{/);
    assert.doesNotMatch(strip(ui), /onChange=\{[^}]*checkUsername/);
  });

  it("登录失败的措辞仍然一视同仁", () => {
    const login = strip(src("lib/auth/password-login.ts"));
    assert.match(login, /GENERIC_LOGIN_ERROR/);
    // 找不到人的时候照样算一次哈希，否则耗时会把答案漏出去
    assert.match(login, /DUMMY_HASH/);
    const fn = login.slice(login.indexOf("function loginWithPassword"));
    assert.ok(
      fn.indexOf("verifyPassword") < fn.indexOf("!user || !credential || !matched"),
      "查不到人时提前返回了",
    );
  });

  it("**resolveIdentity 一次查完，不是查四次**", () => {
    /*
     * 分四次「先查到就返回」的话，不同的列走出不同的查询次数 ——
     * 一个能测出来的时间差，测的正是「你输的是不是一个存在的微信 ID」。
     */
    const code = strip(src("lib/auth/identity.ts"));
    const fn = code.slice(code.indexOf("function resolveIdentity"), code.indexOf("TakenVerdict"));
    assert.equal((fn.match(/\.all\(\)|\.get\(\)/g) ?? []).length, 1, "查了不止一次");
  });
});

describe("接线", () => {
  it("登录接口收 identifier，也还认老的 wxId 字段", () => {
    /*
     * 有人可能把登录页停在标签里好几天，那个页面发出来的还是 wxId ——
     * 改名当天让这些人收到「请填写…」是完全没必要的一次伤害。
     */
    const route = strip(src("app/api/auth/password/route.ts"));
    assert.match(route, /body\?\.identifier/);
    assert.match(route, /body\?\.wxId/);
  });

  it("登录表单发的是 identifier，输入框写明四种都收", () => {
    const form = src("components/auth/PasswordLoginForm.tsx");
    assert.match(form, /identifier: identifier\.trim\(\)/);
    assert.match(form, /aria-label=\{IDENTIFIER_LABEL\}/);
    assert.ok(IDENTIFIER_LABEL.includes("登录名") && IDENTIFIER_LABEL.includes("微信 ID"));
  });

  it("安全页上有设置入口，而且排在密码前面", () => {
    const page = src("app/(app)/me/security/page.tsx");
    assert.match(page, /<LoginNameSetup/);
    assert.ok(page.indexOf("LoginNameSetup") < page.indexOf("<PasswordSetup"), "登录名排到密码后面去了");
  });

  it("写入都记审计、都挡预览态", () => {
    const actions = strip(src("lib/auth/identity-actions.ts"));
    for (const name of ["setUsername", "setPhone", "clearPhone"]) {
      const fn = actions.slice(actions.indexOf(`function ${name}`));
      assert.match(fn.slice(0, 700), /assertNotPreviewing\(\)/, `${name} 少了 assertNotPreviewing`);
      assert.match(fn.slice(0, 900), /audit\(/, `${name} 没记审计`);
    }
  });

  it("规则层不碰数据库", () => {
    const code = src("lib/auth/login-name.ts");
    for (const forbidden of ["server-only", "@/lib/db", "drizzle-orm"]) {
      assert.equal(code.includes(forbidden), false, `规则层引了 ${forbidden}`);
    }
  });
});
