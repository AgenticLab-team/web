import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it, mock } from "node:test";

/**
 * 存储分层裁剪。
 *
 * 这组测试保的是**「删错了能不能救回来」的那条线**：
 *   · 改层与退索引可逆 —— reindexRange 真的能把搜索恢复
 *   · 丢正文不可逆 —— 必须先归档，且归档文件里真的有那些正文
 *   · 上游回不出来的时候，整步跳过并说明理由，而不是安静地删掉
 *
 * 生产上今天一条都不会被裁剪（最老的消息才五周），
 * 所以这里必须用造出来的数据把每一层都真的跑一遍 ——
 * 一个从没被执行过的裁剪任务和一个坏掉的裁剪任务长得一模一样。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-prune-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.ARCHIVE_DIR = join(tmp, "archive");
process.env.NEKOBOT_API_KEY = "nk_test";

type DbModule = typeof import("@/lib/db");
type PruneModule = typeof import("@/lib/storage/prune");
type TierConfig = import("@/lib/storage/tiers").TierConfig;

let dbm: DbModule;
let prune: PruneModule;
let client: typeof import("@/lib/nekobot/client");

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

/** 上游还「记得」哪些消息 —— 用来演回源验证的两种结局 */
let upstreamHas = new Set<string>();
let upstreamThrows = false;

const CONFIG: TierConfig = {
  hotDays: 90,
  warmDays: 365,
  coldKeepQualityOnly: true,
  archiveBeforeDrop: true,
};

before(async () => {
  dbm = await import("@/lib/db");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });

  client = await import("@/lib/nekobot/client");
  mock.method(client.nekobot, "messages", async (query: Record<string, unknown>) => {
    if (upstreamThrows) throw new Error("connect ECONNREFUSED 127.0.0.1:8090");
    const rows = dbm.sqlite
      .prepare(`SELECT id, conv_id, ts FROM messages ORDER BY ts`)
      .all() as { id: string; conv_id: string; ts: number }[];
    const items = rows
      .filter((r) => upstreamHas.has(r.id))
      .filter((r) => {
        if (query.start_ms && r.ts < Number(query.start_ms)) return false;
        if (query.end_ms && r.ts > Number(query.end_ms)) return false;
        if (query.conv_id && r.conv_id !== query.conv_id) return false;
        return true;
      })
      .map((r) => ({ msg_svr_id: r.id, conv_id: r.conv_id, create_time: r.ts }));
    return { total: items.length, limit: 50, offset: 0, returned: items.length, items } as never;
  });

  prune = await import("@/lib/storage/prune");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  dbm.sqlite.exec(`DELETE FROM messages; DELETE FROM messages_fts;`);
  rmSync(join(tmp, "archive"), { recursive: true, force: true });
  upstreamHas = new Set();
  upstreamThrows = false;
});

let seq = 0;

/** 造一条消息，同时按现状建索引 —— 和同步侧写入的形态一致 */
function msg(over: {
  ageDays: number;
  quality?: boolean;
  indexed?: boolean;
  content?: string;
  tier?: string;
  convId?: string;
}) {
  const id = `m${++seq}`;
  const ts = NOW - over.ageDays * DAY;
  const content = over.content ?? `内容 ${id}`;
  const indexed = over.indexed ?? true;
  dbm.sqlite
    .prepare(
      `INSERT INTO messages (id, conv_id, sender_wx_id, sender_name, is_send, type, content, length,
        is_quality, has_media, ts, tier, indexed, synced_at)
       VALUES (?, ?, 'wx_a', 'A', 0, 'text', ?, ?, ?, 0, ?, ?, ?, ?)`,
    )
    .run(
      id,
      over.convId ?? "room@chatroom",
      content,
      content.length,
      over.quality ? 1 : 0,
      ts,
      over.tier ?? "hot",
      indexed ? 1 : 0,
      NOW,
    );
  if (indexed && content !== "") {
    dbm.sqlite
      .prepare(`INSERT INTO messages_fts (msg_id, conv_id, sender_wx_id, content) VALUES (?,?,?,?)`)
      .run(id, over.convId ?? "room@chatroom", "wx_a", content);
  }
  upstreamHas.add(id);
  return id;
}

function ftsCount() {
  return (dbm.sqlite.prepare(`SELECT count(*) n FROM messages_fts`).get() as { n: number }).n;
}
function row(id: string) {
  return dbm.sqlite.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as {
    tier: string;
    indexed: number;
    content: string;
  };
}

describe("预览", () => {
  it("什么都不该动的时候预览全是零", () => {
    msg({ ageDays: 1 });
    msg({ ageDays: 30, quality: true });
    const p = prune.previewPrune(CONFIG, NOW);
    assert.equal(p.unindex, 0);
    assert.equal(p.drop, 0);
    assert.equal(p.retier, 0);
  });

  it("数出会从搜索里消失和会丢正文的条数", () => {
    msg({ ageDays: 100 }); // 温层非高质量 → 退索引
    msg({ ageDays: 100, quality: true }); // 温层高质量 → 不动
    msg({ ageDays: 400 }); // 冷层非高质量 → 退索引 + 丢正文
    msg({ ageDays: 400, quality: true }); // 冷层高质量 → 不动

    const p = prune.previewPrune(CONFIG, NOW);
    assert.equal(p.unindex, 2);
    assert.equal(p.drop, 1);
    assert.ok(p.dropBytes > 0);
    assert.ok(p.unindexBytes > 0);
    assert.equal(p.retier, 4, "四条的 tier 都还写着 hot");
  });

  it("跑过一次之后预览归零 —— 幂等，不会一轮比一轮大", async () => {
    msg({ ageDays: 400 });
    msg({ ageDays: 100 });
    await prune.runPrune({ config: CONFIG, now: NOW });

    const p = prune.previewPrune(CONFIG, NOW);
    assert.equal(p.unindex, 0);
    assert.equal(p.drop, 0);
    assert.equal(p.retier, 0);
  });

  it("关掉「冷层只留高质量」之后不再预告丢正文", () => {
    msg({ ageDays: 400 });
    const p = prune.previewPrune({ ...CONFIG, coldKeepQualityOnly: false }, NOW);
    assert.equal(p.drop, 0);
    assert.ok(p.unindex > 0, "退索引照做");
  });

  it("预览指得出动的是哪一段时间", () => {
    msg({ ageDays: 100 });
    msg({ ageDays: 500 });
    const p = prune.previewPrune(CONFIG, NOW);
    assert.equal(p.oldestTs, NOW - 500 * DAY);
    assert.equal(p.newestTs, NOW - 100 * DAY);
  });
});

describe("① 改层 —— 零风险", () => {
  it("按时间把每条放进正确的层", async () => {
    const hot = msg({ ageDays: 1 });
    const warm = msg({ ageDays: 200 });
    const cold = msg({ ageDays: 400, quality: true });
    await prune.runPrune({ config: CONFIG, now: NOW });

    assert.equal(row(hot).tier, "hot");
    assert.equal(row(warm).tier, "warm");
    assert.equal(row(cold).tier, "cold");
  });

  it("层标错了也能自愈 —— 期望状态每次重新算", async () => {
    const id = msg({ ageDays: 1, tier: "cold" });
    await prune.runPrune({ config: CONFIG, now: NOW });
    assert.equal(row(id).tier, "hot", "本来就该是热层，不该被错误的旧标记粘住");
  });
});

describe("② 退索引 —— 可逆", () => {
  it("过了热层的非高质量消息搜不到了，但正文还在", async () => {
    const id = msg({ ageDays: 200, content: "很久以前的闲聊" });
    await prune.runPrune({ config: CONFIG, now: NOW });

    assert.equal(row(id).indexed, 0);
    assert.equal(row(id).content, "很久以前的闲聊", "退索引不该动正文");
    assert.equal(ftsCount(), 0);
  });

  it("高质量消息在冷层也还搜得到", async () => {
    const id = msg({ ageDays: 500, quality: true });
    await prune.runPrune({ config: CONFIG, now: NOW });
    assert.equal(row(id).indexed, 1);
    assert.equal(ftsCount(), 1);
  });

  it("reindexRange 能把搜索恢复回来 —— 「可逆」不是一句话", async () => {
    const id = msg({ ageDays: 200, content: "找得回来的内容" });
    await prune.runPrune({ config: CONFIG, now: NOW });
    assert.equal(ftsCount(), 0);

    const back = prune.reindexRange(NOW - 300 * DAY, NOW);
    assert.equal(back, 1);
    assert.equal(row(id).indexed, 1);
    const hit = dbm.sqlite
      .prepare(`SELECT msg_id FROM messages_fts WHERE messages_fts MATCH ?`)
      .get("找得回来的内容") as { msg_id: string } | undefined;
    assert.equal(hit?.msg_id, id);
  });

  it("正文已经丢掉的重建不回来 —— 不会插一条空索引进去", async () => {
    msg({ ageDays: 500 });
    await prune.runPrune({ config: CONFIG, now: NOW });
    const back = prune.reindexRange(NOW - 600 * DAY, NOW);
    assert.equal(back, 0);
    assert.equal(ftsCount(), 0);
  });
});

describe("③ 丢正文 —— 不可逆，先归档", () => {
  it("归档文件里真的有那些正文", async () => {
    msg({ ageDays: 400, content: "冷层里被丢掉的一句话" });
    const result = await prune.runPrune({ config: CONFIG, now: NOW });

    assert.equal(result.dropped, 1);
    assert.equal(result.archived.length, 1);

    const file = result.archived[0].file;
    assert.ok(existsSync(file), "归档文件不存在");
    const text = gunzipSync(readFileSync(file)).toString("utf8");
    assert.match(text, /冷层里被丢掉的一句话/, "归档里没有被丢掉的正文");
  });

  it("按月分包，恢复时不用解开全部历史", async () => {
    msg({ ageDays: 400 });
    msg({ ageDays: 500 });
    const result = await prune.runPrune({ config: CONFIG, now: NOW });
    assert.equal(result.archived.length, 2, "两个不同的月应该是两个文件");
  });

  it("同一个月分两次裁剪不会把上一次归档的内容抹掉", async () => {
    msg({ ageDays: 400, content: "第一批" });
    const first = await prune.runPrune({ config: CONFIG, now: NOW });

    msg({ ageDays: 400, content: "第二批" });
    await prune.runPrune({ config: CONFIG, now: NOW });

    const text = gunzipSync(readFileSync(first.archived[0].file)).toString("utf8");
    assert.match(text, /第一批/);
    assert.match(text, /第二批/, "第二次归档把第一次的内容覆盖掉了");
  });

  it("高质量消息的正文一个字都不动", async () => {
    const id = msg({ ageDays: 900, quality: true, content: "值得留下的内容" });
    await prune.runPrune({ config: CONFIG, now: NOW });
    assert.equal(row(id).content, "值得留下的内容");
  });

  it("只做可逆步骤时正文原封不动", async () => {
    const id = msg({ ageDays: 400, content: "还在" });
    const result = await prune.runPrune({ config: CONFIG, now: NOW, reversibleOnly: true });

    assert.equal(result.dropped, 0);
    assert.equal(row(id).content, "还在");
    assert.equal(row(id).indexed, 0, "退索引照做");
    assert.match(result.skipped, /可逆/);
  });
});

describe("回源验证 —— 「删了还能拉回来」必须被验证，不能被相信", () => {
  const noArchive: TierConfig = { ...CONFIG, archiveBeforeDrop: false };

  it("上游全都回得出来就放行", async () => {
    msg({ ageDays: 400 });
    const check = await prune.verifyUpstreamRetention(noArchive, NOW);
    assert.equal(check.ok, true);
    assert.equal(check.found, check.sampled);
  });

  it("上游回不出来就整步跳过，正文一条都不动", async () => {
    const id = msg({ ageDays: 400, content: "上游已经没有了" });
    upstreamHas.delete(id);

    const check = await prune.verifyUpstreamRetention(noArchive, NOW);
    assert.equal(check.ok, false);
    assert.match(check.reason, /前提不成立/);

    const result = await prune.runPrune({ config: noArchive, now: NOW });
    assert.equal(result.dropped, 0);
    assert.equal(row(id).content, "上游已经没有了", "验证没过还是把正文删了");
    assert.match(result.skipped, /磁盘占着总比记录没了强/);
  });

  it("上游问不到时说的是「问不到」，不是「上游没有」", async () => {
    msg({ ageDays: 400 });
    upstreamThrows = true;
    const check = await prune.verifyUpstreamRetention(noArchive, NOW);
    assert.equal(check.ok, false);
    assert.match(check.reason, /问不到/);
    assert.match(check.reason, /不等于/);
  });

  it("没有会被丢的消息时不需要验证，也不去打上游", async () => {
    msg({ ageDays: 10 });
    upstreamThrows = true; // 真去打就会抛
    const check = await prune.verifyUpstreamRetention(noArchive, NOW);
    assert.equal(check.ok, true);
    assert.equal(check.sampled, 0);
  });

  it("开了归档就不再依赖上游 —— 归档本身就是那份副本", async () => {
    msg({ ageDays: 400 });
    upstreamThrows = true;
    const result = await prune.runPrune({ config: CONFIG, now: NOW });
    assert.equal(result.dropped, 1, "有归档时不该被上游不可达挡住");
  });
});

describe("配置讲不通就不执行", () => {
  it("温层不大于热层时直接抛错，而不是跑一半", async () => {
    msg({ ageDays: 400, content: "不该被动" });
    await assert.rejects(
      () => prune.runPrune({ config: { ...CONFIG, warmDays: 90 }, now: NOW }),
      /讲不通/,
    );
    assert.equal(ftsCount(), 1, "抛错前不该已经动过索引");
  });
});

describe("正文完整性的下界", () => {
  it("没丢过任何正文时是 null —— 没有下界就是全都在", async () => {
    msg({ ageDays: 400, quality: true });
    await prune.runPrune({ config: CONFIG, now: NOW });
    assert.equal(prune.fullContentSince(), null);
  });

  it("丢过之后指得出「早于这个时间的闲聊可能已经没了」", async () => {
    msg({ ageDays: 400 });
    msg({ ageDays: 10 });
    await prune.runPrune({ config: CONFIG, now: NOW });
    assert.equal(prune.fullContentSince(), NOW - 400 * DAY);
  });
});
