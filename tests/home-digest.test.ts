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
