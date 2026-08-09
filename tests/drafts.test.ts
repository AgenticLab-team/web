import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  DIVERGED_MS,
  MAX_DRAFT_CHARS,
  SERVER_SAVE_INTERVAL_MS,
  canReadDraft,
  checkConflict,
  checkDraft,
  draftKey,
  pickDraft,
} from "@/lib/forum/draft-rules";

/**
 * 服务端草稿。
 *
 * ─────────────────────────────────────────
 * 表建了，一行代码没读过
 * ─────────────────────────────────────────
 *
 * `forum_drafts` 整张表在 schema 之外零引用。草稿全在 localStorage 里，
 * 只在同一个浏览器、同一台设备上找得回来。
 *
 * 而这个站大部分人是在**微信内置浏览器**里打开的 ——
 * 那里的页面随时被系统回收，切出去回条消息再回来，
 * 写了一半的帖子就没了。
 *
 * ─────────────────────────────────────────
 * 两台设备一份草稿，这才是真正难的地方
 * ─────────────────────────────────────────
 *
 * 表上是 unique(user, target_type, target_id)。「谁存得晚谁赢」的话，
 * 手机上放着的一个旧版本会在下次定时保存时把电脑上刚写的两千字
 * **悄悄覆盖掉** —— 没有提示，也没有办法找回。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

describe("草稿的键", () => {
  it("**永远非空** —— SQLite 的唯一索引不约束 NULL", () => {
    /*
     * 两行 (user, "post", NULL) 是合法的。放行 null 的话，
     * 同一个人会攒出一堆互相看不见的「新帖草稿」。
     */
    assert.equal(draftKey({ target: "post", scope: "" }), "_");
    assert.equal(draftKey({ target: "post", scope: "   " }), "_");
    assert.equal(draftKey({ target: "post", scope: "general" }), "general");
  });
});

describe("内容校验", () => {
  it("正常的过", () => {
    const r = checkDraft({ content: "写了一半" });
    assert.equal(r.ok && "content" in r && r.content, "写了一半");
  });

  it("**空的是删掉，不是存一行空的**", () => {
    /*
     * 存了的话，「有一份草稿」的提示会为一份空草稿亮起来 ——
     * 点开之后什么都没有，比没有提示更让人困惑。
     */
    const r = checkDraft({ content: "   \n " });
    assert.equal(r.ok, true);
    assert.ok("discard" in r);
  });

  it("有标题没正文也算有内容 —— 想好了标题正要写", () => {
    const r = checkDraft({ title: "关于那件事", content: "" });
    assert.equal("discard" in r, false);
  });

  it("太长要拒", () => {
    assert.equal(checkDraft({ content: "长".repeat(MAX_DRAFT_CHARS + 1) }).ok, false);
  });

  it("**正文不 trim** —— 缩进和空行是 Markdown 的一部分", () => {
    const r = checkDraft({ content: "  - 一\n  - 二\n" });
    assert.equal(r.ok && "content" in r && r.content, "  - 一\n  - 二\n");
  });
});

describe("**冲突：不能悄悄盖掉别的设备**", () => {
  it("服务器上没有就直接存", () => {
    assert.equal(checkConflict({ serverUpdatedAt: null, base: 0 }).ok, true);
  });

  it("服务器那份就是我手上这份 —— 存", () => {
    assert.equal(checkConflict({ serverUpdatedAt: 1000, base: 1000 }).ok, true);
  });

  it("**服务器那份更新 —— 拒**", () => {
    const r = checkConflict({ serverUpdatedAt: 2000, base: 1000 });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /另一台设备/);
  });

  it("手上这份基于更新的版本（时钟漂移）—— 放行，不要卡死", () => {
    assert.equal(checkConflict({ serverUpdatedAt: 1000, base: 2000 }).ok, true);
  });

  it("**用 > 不是 >=** —— 否则同一毫秒内连存两次会开始自己跟自己打架", () => {
    assert.equal(checkConflict({ serverUpdatedAt: 5, base: 5 }).ok, true);
  });
});

describe("本地和服务端各有一份，用哪个", () => {
  const snap = (content: string, updatedAt: number) => ({ content, title: null, updatedAt });

  it("只有一边就用那一边", () => {
    assert.deepEqual(pickDraft({ local: snap("a", 1), server: null }), { pick: "local", ask: false });
    assert.deepEqual(pickDraft({ local: null, server: snap("a", 1) }), { pick: "server", ask: false });
    assert.deepEqual(pickDraft({ local: null, server: null }), { pick: "neither", ask: false });
  });

  it("内容一样就不问", () => {
    const r = pickDraft({ local: snap("同样的", 100), server: snap("同样的", 50) });
    assert.equal(r.ask, false);
  });

  it("时间接近时选新的那个，不打扰人", () => {
    const r = pickDraft({ local: snap("本地", 1000), server: snap("服务器", 900) });
    assert.equal(r.pick, "local");
    assert.equal(r.ask, false);
  });

  it("**并列时选本地** —— 本地 3 秒存一次，更可能包含最后那几个字", () => {
    const r = pickDraft({ local: snap("本地", 1000), server: snap("服务器", 1000) });
    assert.equal(r.pick, "local");
  });

  it("**差得远就问人** —— 那是「电脑写一半又在手机上开了同一个编辑器」", () => {
    /*
     * 自动挑一份就一定会丢掉另一份，而两段自由文本没有正确的
     * 自动合并方式 —— 机器一合就是把两句话搅在一起。
     */
    const r = pickDraft({ local: snap("本地", 1000), server: snap("服务器", 1000 + DIVERGED_MS + 1) });
    assert.equal(r.ask, true);
    assert.equal(r.pick, "server");
  });

  it("**老格式的本地草稿时间是 0，于是服务器赢** —— 这是更安全的一边", () => {
    const r = pickDraft({ local: snap("老的裸字符串", 0), server: snap("服务器", 1000) });
    assert.equal(r.pick, "server");
  });
});

describe("**草稿只有本人碰得到**", () => {
  it("规则层说死了", () => {
    assert.equal(canReadDraft("u1", "u1"), true);
    assert.equal(canReadDraft("u2", "u1"), false);
    assert.equal(canReadDraft(null, "u1"), false);
  });

  it("**查询层没有「按 id 取草稿」的签名** —— 没有签名，后台就渲染不出来", () => {
    /*
     * 草稿是还没发表的东西。已发表的内容有可见性规则、有版主、有审计；
     * 草稿一样都没有 —— 它甚至可能是一句写到一半就决定不发的话。
     */
    const code = src("lib/forum/drafts.ts");
    for (const fn of ["getDraft", "listDrafts", "draftCount", "dropDraft"]) {
      const at = code.indexOf(`export function ${fn}`);
      assert.ok(at > 0, `${fn} 不见了`);
      assert.match(code.slice(at, at + 110), /\(\s*\n?\s*userId: string/, `${fn} 第一个参数不是 userId`);
    }
    assert.doesNotMatch(code, /getDraftById|draftsOf\(/);
  });

  it("**后台没有任何地方读草稿** —— 整棵 admin 树都扫一遍", () => {
    /*
     * 这一条是给以后的人看的：草稿箱做出来之后，
     * 「后台能不能看用户在写什么」是个很自然会冒出来的念头，
     * 而它的答案必须一直是不能。
     */
    const roots = [
      new URL("../src/lib/admin", import.meta.url),
      new URL("../src/app/(app)/admin", import.meta.url),
      new URL("../src/components/admin", import.meta.url),
    ];

    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of readdirSync(root, { recursive: true, encoding: "utf8" })) {
        if (!/\.tsx?$/.test(file)) continue;
        const text = readFileSync(new URL(`${root.pathname}/${file}`, "file:"), "utf8");
        if (/forum\/drafts|schema\/forum".*drafts|\bdrafts\b\s*[,}]/.test(text)) {
          offenders.push(file);
        }
      }
    }
    assert.deepEqual(offenders, [], "后台读到草稿了");
  });

  it("接口和 action 都从会话取 userId，不从入参", () => {
    const route = strip(src("app/api/forum/draft/route.ts"));
    assert.match(route, /getCurrentUser\(\)/);
    assert.match(route, /userId: user\.id/);
    assert.doesNotMatch(route, /body\?\.userId/);

    const actions = strip(src("lib/forum/draft-actions.ts"));
    assert.match(actions, /getCurrentUser\(\)/);
    assert.match(actions, /dropDraft\(user\.id/);
  });
});

describe("**页面被杀掉那一刻要救得回来**", () => {
  it("保存走接口而不是 server action —— sendBeacon 发不了 server action", () => {
    /*
     * 最需要保住那一次保存的时刻，恰恰是页面正在被回收的时刻，
     * 而那时 server action 那条链路已经来不及了。
     */
    const hook = strip(src("components/forum/use-server-draft.ts"));
    assert.match(hook, /navigator\.sendBeacon/);
    assert.match(hook, /"\/api\/forum\/draft"/);
  });

  it("**用 pagehide 而不是 beforeunload** —— iOS 与微信 webview 被回收时不触发后者", () => {
    const hook = src("components/forum/use-server-draft.ts");
    assert.match(hook, /addEventListener\("pagehide"/);
    assert.match(hook, /visibilitychange/);
    assert.doesNotMatch(strip(hook), /addEventListener\("beforeunload"/);
  });

  it("定时保存和抢救保存走同一条路 —— 两条的话最要紧那条平时跑不到", () => {
    const hook = strip(src("components/forum/use-server-draft.ts"));
    assert.equal((hook.match(/\/api\/forum\/draft/g) ?? []).length, 2, "路径不止一个");
  });

  it("服务端保存比本地稀疏一些", () => {
    assert.ok(SERVER_SAVE_INTERVAL_MS >= 5_000 && SERVER_SAVE_INTERVAL_MS <= 30_000);
  });
});

describe("**老格式的本地草稿要认**", () => {
  it("裸字符串也读得出来", () => {
    /*
     * 换格式那一刻，已经在别人浏览器里躺着的草稿是裸字符串。
     * 不认的话，这次为了保住草稿而做的改动，第一件事是把草稿全弄丢。
     */
    const code = src("components/forum/local-draft.ts");
    assert.match(code, /if \(!raw\.startsWith\("\{"\)\)/);
    // 解析失败也不丢内容
    assert.match(strip(code), /catch \{[\s\S]{0,200}return raw\.trim\(\)/);
  });
});

describe("接线", () => {
  it("发帖成功后删掉服务端草稿", () => {
    /*
     * 不删的话，下次点「发帖」会把已经发表过的内容当草稿恢复出来，
     * 而人多半会以为上次没发成功，于是再发一遍。
     */
    const actions = strip(src("lib/forum/actions.ts"));
    assert.match(actions, /dropDraft\(user\.id, "post", board\.key\)/);
    assert.match(actions, /dropDraft\(user\.id, "reply", input\.postId\)/);
  });

  it("发帖页和帖子页都把服务端草稿传下去了", () => {
    assert.match(src("app/(app)/forum/new/page.tsx"), /getDraft\(user\.id, "post", b\.key\)/);
    assert.match(src("app/(app)/forum/p/[id]/page.tsx"), /getDraft\(user\.id, "reply", post\.id\)/);
    assert.match(src("components/forum/ReplyForm.tsx"), /useServerDraft\(/);
    assert.match(src("components/forum/ComposeForm.tsx"), /useServerDraft\(/);
  });

  it("**恢复草稿要有显式通道** —— defaultValue 只在挂载时读一次", () => {
    const editor = src("components/forum/Editor.tsx");
    assert.match(editor, /restoreValue\?: string \| null;/);
    // 比对过再写，否则每次父组件重渲染都会把光标打回原处
    assert.match(strip(editor), /if \(ref\.current\?\.value === restoreValue\) return;/);
  });

  it("草稿箱有入口，桌面和手机同一份 NAV", () => {
    const nav = src("lib/nav.ts");
    assert.match(nav, /key: "drafts"/);
    assert.match(nav, /href: "\/me\/drafts"/);
    assert.match(src("components/shell/icons.tsx"), /"file-text": FileText,/);
    assert.match(src("app/(app)/me/page.tsx"), /href="\/me\/drafts"/);
  });

  it("**删草稿要问一次** —— 这份内容只存在这里，没有回收站", () => {
    const list = src("components/forum/DraftList.tsx");
    assert.match(list, /删了就没了/);
    assert.match(list, /setConfirming\(true\)/);
  });

  it("「不用了」只收起提示，不删服务器上那份", () => {
    const compose = strip(src("components/forum/ComposeForm.tsx"));
    const at = compose.indexOf("不用了");
    assert.ok(at > 0);
    assert.doesNotMatch(compose.slice(at - 400, at), /discardDraft|dropDraft/);
  });

  it("规则层不碰数据库", () => {
    const code = src("lib/forum/draft-rules.ts");
    for (const forbidden of ["server-only", "@/lib/db", "drizzle-orm"]) {
      assert.equal(code.includes(forbidden), false, `规则层引了 ${forbidden}`);
    }
  });

  it("用 SVG 图标不用 emoji", () => {
    for (const f of ["components/forum/DraftList.tsx", "components/forum/DraftSync.tsx"]) {
      assert.match(src(f), /lucide-react/);
      assert.doesNotMatch(strip(src(f)), /[\u{1F300}-\u{1FAFF}]/u);
    }
  });
});

/* ───────────────────────────────────────────────────────────────
 * 覆盖那一条只有真数据库才测得出来
 * ─────────────────────────────────────────────────────────────── */

const tmp = mkdtempSync(join(tmpdir(), "al-drafts-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

let dbm: typeof import("@/lib/db");
let schema: typeof import("@/lib/db/schema");
let store: typeof import("@/lib/forum/drafts");

const ME = "u_me";
const OTHER = "u_other";

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  store = await import("@/lib/forum/drafts");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  dbm.db.delete(schema.drafts).run();
});

describe("**存与取**", () => {
  it("存了能取回来", () => {
    const saved = store.saveDraft({ userId: ME, target: "post", scope: "general", content: "写了一半", base: 0, now: 1000 });
    assert.equal(saved.ok, true);

    const got = store.getDraft(ME, "post", "general");
    assert.equal(got?.content, "写了一半");
    assert.equal(got?.updatedAt, 1000);
  });

  it("**别人取不到** —— 同一个 scope 也不行", () => {
    store.saveDraft({ userId: ME, target: "post", scope: "general", content: "我的", base: 0, now: 1000 });
    assert.equal(store.getDraft(OTHER, "post", "general"), null);
  });

  it("两个人可以在同一个版块各有一份", () => {
    store.saveDraft({ userId: ME, target: "post", scope: "general", content: "我的", base: 0, now: 1000 });
    store.saveDraft({ userId: OTHER, target: "post", scope: "general", content: "他的", base: 0, now: 1000 });
    assert.equal(store.getDraft(ME, "post", "general")?.content, "我的");
    assert.equal(store.getDraft(OTHER, "post", "general")?.content, "他的");
  });

  it("同一个人换版块是两份 —— 在「问答」写的不该在「展示」冒出来", () => {
    store.saveDraft({ userId: ME, target: "post", scope: "qa", content: "问答的", base: 0, now: 1000 });
    store.saveDraft({ userId: ME, target: "post", scope: "showcase", content: "展示的", base: 0, now: 1000 });
    assert.equal(store.getDraft(ME, "post", "qa")?.content, "问答的");
    assert.equal(store.getDraft(ME, "post", "showcase")?.content, "展示的");
  });

  it("**帖子草稿和回复草稿互不干扰**", () => {
    store.saveDraft({ userId: ME, target: "post", scope: "x", content: "帖子", base: 0, now: 1000 });
    store.saveDraft({ userId: ME, target: "reply", scope: "x", content: "回复", base: 0, now: 1000 });
    assert.equal(store.getDraft(ME, "post", "x")?.content, "帖子");
    assert.equal(store.getDraft(ME, "reply", "x")?.content, "回复");
  });
});

describe("**旧版本不能盖掉新版本**", () => {
  it("电脑上写完之后，手机上那份旧的存不进去", () => {
    // 电脑：存到 t=2000
    store.saveDraft({ userId: ME, target: "post", scope: "general", content: "电脑上写的两千字", base: 0, now: 2000 });

    // 手机：手上那份是 t=1000 时看到的，现在要存
    const phone = store.saveDraft({
      userId: ME, target: "post", scope: "general", content: "手机上写了两个字", base: 1000, now: 3000,
    });

    assert.equal(phone.ok, false);
    assert.equal(store.getDraft(ME, "post", "general")?.content, "电脑上写的两千字", "被盖掉了");
  });

  it("**冲突时把服务器那份带回去** —— 客户端不必再请求一次", () => {
    store.saveDraft({ userId: ME, target: "post", scope: "general", content: "服务器上的", base: 0, now: 2000 });
    const r = store.saveDraft({ userId: ME, target: "post", scope: "general", content: "我的", base: 1000, now: 3000 });

    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.server?.content, "服务器上的");
  });

  it("对齐 base 之后就能存进去了 —— 人选了「用我这份」", () => {
    store.saveDraft({ userId: ME, target: "post", scope: "general", content: "旧的", base: 0, now: 2000 });
    const r = store.saveDraft({ userId: ME, target: "post", scope: "general", content: "我的", base: 2000, now: 3000 });
    assert.equal(r.ok, true);
    assert.equal(store.getDraft(ME, "post", "general")?.content, "我的");
  });

  it("**清空也要过冲突判定** —— 手机上全选删掉不该抹掉电脑上刚写的", () => {
    store.saveDraft({ userId: ME, target: "post", scope: "general", content: "电脑上写的", base: 0, now: 2000 });
    const wipe = store.saveDraft({ userId: ME, target: "post", scope: "general", content: "", base: 1000, now: 3000 });

    assert.equal(wipe.ok, false);
    assert.equal(store.getDraft(ME, "post", "general")?.content, "电脑上写的", "被清掉了");
  });

  it("清空且没冲突时是真的删掉", () => {
    store.saveDraft({ userId: ME, target: "post", scope: "general", content: "写过", base: 0, now: 2000 });
    const wipe = store.saveDraft({ userId: ME, target: "post", scope: "general", content: "  ", base: 2000, now: 3000 });
    assert.equal(wipe.ok, true);
    assert.equal(store.getDraft(ME, "post", "general"), null);
  });
});

describe("列表与删除", () => {
  it("按最后编辑时间倒序", () => {
    store.saveDraft({ userId: ME, target: "post", scope: "a", content: "早的", base: 0, now: 1000 });
    store.saveDraft({ userId: ME, target: "post", scope: "b", content: "晚的", base: 0, now: 2000 });
    assert.deepEqual(store.listDrafts(ME).map((d) => d.targetId), ["b", "a"]);
  });

  it("**只列自己的**", () => {
    store.saveDraft({ userId: OTHER, target: "post", scope: "a", content: "他的", base: 0, now: 1000 });
    assert.deepEqual(store.listDrafts(ME), []);
    assert.equal(store.draftCount(ME), 0);
  });

  it("摘要压平空白并截断 —— 这一页是用来认出是哪篇的", () => {
    store.saveDraft({ userId: ME, target: "post", scope: "a", content: "第一行\n\n第二行", base: 0, now: 1000 });
    assert.equal(store.listDrafts(ME)[0].excerpt, "第一行 第二行");
  });

  it("dropDraft 只删自己的那份", () => {
    store.saveDraft({ userId: ME, target: "post", scope: "a", content: "我的", base: 0, now: 1000 });
    store.saveDraft({ userId: OTHER, target: "post", scope: "a", content: "他的", base: 0, now: 1000 });

    store.dropDraft(ME, "post", "a");
    assert.equal(store.getDraft(ME, "post", "a"), null);
    assert.equal(store.getDraft(OTHER, "post", "a")?.content, "他的", "删到别人的了");
  });
});
