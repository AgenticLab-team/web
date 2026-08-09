import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { stripComments as strip } from "./_source";

/**
 * 首页那块「你不在的时候」。
 *
 * ─────────────────────────────────────────
 * 它是这个站上唯一一块「为明天还会打开而存在」的内容
 * ─────────────────────────────────────────
 *
 * 所以它的两条原则不是排版偏好，是这块东西能不能成立的前提：
 *
 *   1. **每个数字后面都得有个能去的地方。**
 *      站长报的「值得看的发言那个有问题」就是这一条塌了 ——
 *      「昨天群里有 N 条值得看的发言」指向 `/messages`，
 *      而这个站根本没有这个路由，点开是 404。
 *      首页第一块、回来的第一个理由，点开是张白纸。
 *
 *   2. **数字要具体。** 「昨天」就得是昨天：口径和链接必须是同一天，
 *      否则人点进去看到的是另一天的记录，比 404 更让人怀疑这些数字。
 */

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/**
 * 站里真实存在的页面路由。
 *
 * 按 App Router 的规则从目录结构反推：`(x)` 是分组、不进 URL，
 * 有 page.tsx 的目录才是一个能去的地方。
 * 手写一张清单是没用的 —— 清单和实际路由脱节的那天，
 * 这个测试就开始替坏链接背书。
 */
function pageRoutes(dir = join(ROOT, "src/app"), prefix = ""): Set<string> {
  const out = new Set<string>();
  if (readdirSync(dir).includes("page.tsx")) out.add(prefix === "" ? "/" : prefix);
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (!statSync(full).isDirectory()) continue;
    // (app) 这类分组不进 URL；_x 是私有目录，本来就不可路由
    if (entry.startsWith("_")) continue;
    const next = entry.startsWith("(") && entry.endsWith(")") ? prefix : `${prefix}/${entry}`;
    for (const r of pageRoutes(full, next)) out.add(r);
  }
  return out;
}

describe("**每个数字后面都得有个能去的地方**", () => {
  const card = strip(
    readFileSync(join(ROOT, "src/components/home/DigestCard.tsx"), "utf8"),
  );

  /** 卡片上那几条的 href。模板串里的 ${...} 只影响查询串，路径部分是写死的 */
  const hrefs = [...card.matchAll(/href:\s*[`"']([^`"']+)/g)].map((m) => m[1]);

  it("卡片上确实有几个入口 —— 一个都没抓到说明这个测试自己坏了", () => {
    assert.ok(hrefs.length >= 3, `只抓到 ${hrefs.length} 个 href，正则跟不上了`);
  });

  it("**每个入口都指向一个真实存在的页面**", () => {
    /*
     * 这条守的是站长报的那个 bug：`/messages` 这个路由从来没建过，
     * 而「昨天群里有 N 条值得看的发言」一直指着它。
     * 首页上人最可能点的第一个数字，点开是 404。
     */
    const routes = pageRoutes();
    const dead = hrefs.filter((h) => !routes.has(h.split("?")[0]));
    assert.deepEqual(dead, [], "这些入口点开是 404");
  });

  it("群聊那条要落到「按天回看」的具体某一天", () => {
    // 落到今天的空页面等于告诉人刚才那行数字是假的
    assert.match(card, /\/archive\?date=\$\{digest\.chatDateKey\}/);
  });
});

/*
 * 下面这段要真的建库 —— 「昨天」的口径是 SQL 里的两个边界，
 * 只有跑一遍才知道它切在哪。
 */
const tmp = mkdtempSync(join(tmpdir(), "al-digest-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

type DbModule = typeof import("@/lib/db");
type SchemaModule = typeof import("@/lib/db/schema");
type DigestModule = typeof import("@/lib/queries/digest");
type TimeModule = typeof import("@/lib/time");

let dbm: DbModule;
let schema: SchemaModule;
let digest: DigestModule;
let time: TimeModule;

const CONV = "g_digest@chatroom";
const WX = "wxid_digest_alice";

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  digest = await import("@/lib/queries/digest");
  time = await import("@/lib/time");

  const yesterday = time.shiftDateKey(time.todayKey(), -1);
  const rows: { id: string; ts: number; quality: boolean }[] = [
    // 昨天的三条，其中两条够格
    { id: "m_y1", ts: time.startOfDayMs(yesterday), quality: true },
    { id: "m_y2", ts: time.startOfDayMs(yesterday) + 3_600_000, quality: true },
    { id: "m_y3", ts: time.startOfDayMs(yesterday) + 7_200_000, quality: false },
    // 昨天最后一毫秒 —— 边界要含进来
    { id: "m_y4", ts: time.startOfDayMs(time.todayKey()) - 1, quality: true },
    // 今天零点整 —— 边界要排除掉
    { id: "m_t1", ts: time.startOfDayMs(time.todayKey()), quality: true },
    // 前天
    { id: "m_d1", ts: time.startOfDayMs(yesterday) - 1, quality: true },
  ];

  for (const row of rows) {
    dbm.db
      .insert(schema.messages)
      .values({
        id: row.id,
        convId: CONV,
        senderWxId: WX,
        senderName: "阿丽",
        type: "text",
        content: "一段够长的正常发言内容",
        length: 11,
        isQuality: row.quality,
        ts: row.ts,
      })
      .run();
  }
});

after(() => rmSync(tmp, { recursive: true, force: true }));

describe("**「昨天」的口径和链接必须是同一天**", () => {
  it("只数昨天那一整天，边界一头含一头不含", () => {
    /*
     * 东八区切日（见 lib/time.ts）。跨零点那一刻的消息算哪天，
     * 决定了首页数字和「按天回看」页看到的是不是同一批。
     */
    const d = digest.buildDigest(null, [CONV]);
    assert.equal(d.chatQualityYesterday, 3, "昨天的高质量发言数不对");
  });

  it("**数字说的哪一天要带出去** —— 链接得能落到那一天", () => {
    const d = digest.buildDigest(null, [CONV]);
    assert.equal(d.chatDateKey, time.shiftDateKey(time.todayKey(), -1));
  });

  it("不在任何群的人不统计 —— 群消息是隐私，不能靠前端不显示来兜", () => {
    const d = digest.buildDigest(null, []);
    assert.equal(d.chatQualityYesterday, 0);
  });
});

/* ───────────────────────────────────────────────────────────────
 * 没写完的草稿
 *
 * 线上 56 篇帖子对着 8 份草稿，其中两份上千字 ——
 * 有人认真写了一半，而**没有任何地方提醒过他**。
 * 草稿页藏在「我的」下面，离开那个编辑器之后它就消失了。
 *
 * 一篇写了一半的东西，比任何「有 3 篇新帖」都更能把人叫回来 ——
 * 那是他自己的东西，也是唯一一个别人替代不了的理由。
 * ─────────────────────────────────────────────────────────────── */

describe("真库：草稿", async () => {
  const tmp2 = mkdtempSync(join(tmpdir(), "al-digest-drafts-"));
  process.env.DB_PATH ??= join(tmp2, "test.db");
  process.env.NEKOBOT_API_KEY ??= "nk_test";

  const dbm = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  const q = await import("@/lib/queries/digest");

  after(() => rmSync(tmp2, { recursive: true, force: true }));

  const USER = "u_writer";
  const viewer = () =>
    ({ id: USER, wxId: "wx_w", status: "active", kind: "member" }) as unknown as Parameters<
      typeof q.buildDigest
    >[0];

  const reset = () => {
    dbm.db.delete(schema.drafts).run();
    dbm.db.delete(schema.users).run();
    dbm.db.insert(schema.users).values({ id: USER, wxId: "wx_w", status: "active" }).run();
  };

  let n = 0;
  const draft = (over: { title?: string | null; content?: string; updatedAt?: number } = {}) =>
    dbm.db
      .insert(schema.drafts)
      .values({
        userId: USER,
        targetType: "post",
        targetId: `t${++n}`,
        title: over.title ?? null,
        content: over.content ?? "写了一半",
        updatedAt: over.updatedAt ?? Date.now(),
      })
      .run();

  it("没有草稿就是 0，不显示那一行", () => {
    reset();
    const d = q.buildDigest(viewer(), []);
    assert.equal(d.drafts, 0);
    assert.equal(d.draftTitle, null);
  });

  it("有草稿就数出来", () => {
    reset();
    draft();
    draft();
    assert.equal(q.buildDigest(viewer(), []).drafts, 2);
  });

  it("**只有一份时报标题** —— 他一眼就想起来写到哪儿了", () => {
    reset();
    draft({ title: "人脑相当于多大的 AI 模型？" });
    assert.equal(q.buildDigest(viewer(), []).draftTitle, "人脑相当于多大的 AI 模型？");
  });

  it("**多份时不报标题** —— 报哪一份都是武断的", () => {
    reset();
    draft({ title: "甲" });
    draft({ title: "乙" });
    assert.equal(q.buildDigest(viewer(), []).draftTitle, null);
  });

  it("没标题的那份不编名字", () => {
    reset();
    draft({ title: null });
    assert.equal(q.buildDigest(viewer(), []).draftTitle, null);
  });

  it("标题只有空白也不算有名字", () => {
    reset();
    draft({ title: "   " });
    assert.equal(q.buildDigest(viewer(), []).draftTitle, null);
  });

  it("**不设时间窗** —— 放了三天的草稿更需要有人提一句", () => {
    /*
     * 别的几项都只看最近 24 小时（「你不在的时候」发生了什么），
     * 而一份写了一半的东西不会因为放久了就不算数。
     */
    reset();
    draft({ updatedAt: Date.now() - 30 * 86_400_000 });
    assert.equal(q.buildDigest(viewer(), []).drafts, 1);
  });

  it("**别人的草稿不算**", () => {
    reset();
    dbm.db.insert(schema.users).values({ id: "u_other", wxId: "wx_o", status: "active" }).run();
    dbm.db
      .insert(schema.drafts)
      .values({ userId: "u_other", targetType: "post", targetId: "x", content: "别人的" })
      .run();
    assert.equal(q.buildDigest(viewer(), []).drafts, 0);
  });

  it("未登录访客不查这一项", () => {
    reset();
    draft();
    assert.equal(q.buildDigest(null, []).drafts, 0);
  });
});

describe("草稿那一行的显示", () => {
  const card = strip(
    readFileSync(new URL("../src/components/home/DigestCard.tsx", import.meta.url), "utf8"),
  );

  it("**排在最前面** —— 那是他自己的东西", () => {
    const items = card.slice(card.indexOf("const items = ["));
    assert.ok(
      items.indexOf('key: "drafts"') < items.indexOf('key: "replies"'),
      "草稿那一行跑到别人的动静后面去了",
    );
  });

  it("有标题就报标题", () => {
    assert.match(card, /《\$\{digest\.draftTitle\}》还没写完/);
  });

  it("点得进草稿页 —— 每个数字后面都得有个能去的地方", () => {
    assert.match(card, /href: "\/me\/drafts"/);
  });

  it("**只给登录用户** —— 访客没有草稿", () => {
    const block = card.slice(card.indexOf('key: "drafts"') - 200, card.indexOf('key: "drafts"'));
    assert.match(block, /loggedIn &&/);
  });
});
