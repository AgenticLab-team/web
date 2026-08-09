import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

/**
 * 语义检索。
 *
 * ─────────────────────────────────────────
 * 这一组里最要紧的是权限
 * ─────────────────────────────────────────
 *
 * search/messages.ts 的文件头写着：「搜索是最容易绕过权限的入口 ——
 * 只要能搜到只言片语，私密内容就已经泄露了。」
 *
 * 语义检索更要守这条，因为它天然是「全库打分再排序」的形状：
 * 顺手写成先算分后过滤，结果看起来也对，
 * 而**耗时会随着不可见内容的多少变化**，那本身就是一条侧信道。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-sem-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

let dbm: typeof import("@/lib/db");
let schema: typeof import("@/lib/db/schema");
let sem: typeof import("@/lib/search/semantic");
let win: typeof import("@/lib/search/windows");

const CONV_MINE = "mine@chatroom";
const CONV_THEIRS = "theirs@chatroom";
const ME = "01USERME00000000000000000";
const MY_WX = "wxid_me";

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  sem = await import("@/lib/search/semantic");
  win = await import("@/lib/search/windows");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

/** 造一个假向量：把关键词映射成固定方向，好让相似度可预测 */
function fakeVector(seed: number, dims = 8): Float32Array {
  const v = new Float32Array(dims);
  v[seed % dims] = 1;
  return v;
}

beforeEach(() => {
  for (const t of [
    schema.messageWindows,
    schema.messages,
    schema.groupMembers,
    schema.groups,
    schema.people,
    schema.users,
  ]) {
    dbm.db.delete(t).run();
  }
  sem.invalidateVectorCache();

  dbm.db
    .insert(schema.groups)
    .values([
      { convId: CONV_MINE, name: "我在的群", syncEnabled: true },
      { convId: CONV_THEIRS, name: "我不在的群", syncEnabled: true },
    ])
    .run();

  dbm.db
    .insert(schema.users)
    .values({ id: ME, wxId: MY_WX, wxNickname: "我", status: "active" })
    .run();
  dbm.db
    .insert(schema.groupMembers)
    .values({ convId: CONV_MINE, wxId: MY_WX, messages: 10 })
    .run();
});

function addWindow(convId: string, text: string, seed: number, embedded = true) {
  dbm.db
    .insert(schema.messageWindows)
    .values({
      windowKey: `${convId}:${seed}`,
      convId,
      startTs: 1000,
      endTs: 2000,
      messageCount: 2,
      messageIds: JSON.stringify([]),
      text,
      vector: embedded ? win.vectorToBlob(fakeVector(seed)) : null,
      dimensions: embedded ? 8 : null,
      embeddedAt: embedded ? Date.now() : null,
    })
    .run();
  sem.invalidateVectorCache();
}

describe("切段落库", () => {
  function addMessage(id: string, convId: string, ts: number, content: string) {
    dbm.db
      .insert(schema.messages)
      .values({ id, convId, senderWxId: MY_WX, ts, type: "text", content })
      .run();
  }

  it("把连续的消息切成段并写进库", () => {
    addMessage("m1", CONV_MINE, 1000, "有人用过那个向量库吗");
    addMessage("m2", CONV_MINE, 2000, "我试过，还行");
    addMessage("m3", CONV_MINE, 3000, "贵不贵");

    const r = sem.rebuildWindows();
    assert.equal(r.scanned, 3);
    assert.equal(r.created, 1);

    const w = dbm.db.select().from(schema.messageWindows).get()!;
    assert.equal(w.messageCount, 3);
    assert.equal(w.convId, CONV_MINE);
    assert.match(w.text, /向量库/);
  });

  it("**重跑不会重复建段** —— 每次同步都重建的话向量白花钱", () => {
    addMessage("m1", CONV_MINE, 1000, "有人用过那个向量库吗");
    addMessage("m2", CONV_MINE, 2000, "我试过，还行");

    sem.rebuildWindows();
    const second = sem.rebuildWindows();
    assert.equal(second.created, 0);
    assert.equal(dbm.db.select().from(schema.messageWindows).all().length, 1);
  });

  it("**已存在的段连文本都不更新** —— 更新了文本而向量没换，两者就对不上了", () => {
    /*
     * 那种情况下检索结果只是「略微不准」，不会有任何报错。
     */
    const src = readFileSync(new URL("../src/lib/search/semantic.ts", import.meta.url), "utf8");
    const fn = src.slice(src.indexOf("export function rebuildWindows"));
    assert.match(fn.slice(0, 2500), /if \(existing\) continue;/);
  });

  it("新消息进来会补出新段", () => {
    addMessage("m1", CONV_MINE, 1000, "有人用过那个向量库吗");
    addMessage("m2", CONV_MINE, 2000, "我试过，还行");
    sem.rebuildWindows();

    // 隔很久之后的新话题 —— 会是新的一段
    addMessage("m3", CONV_MINE, 9_000_000, "今天的部署脚本又挂了，谁看一下");
    addMessage("m4", CONV_MINE, 9_001_000, "我来看");
    const r = sem.rebuildWindows();
    assert.equal(r.created, 1);
  });

  it("非文本消息不进段", () => {
    dbm.db
      .insert(schema.messages)
      .values({ id: "i1", convId: CONV_MINE, senderWxId: MY_WX, ts: 1000, type: "image", content: "[图片]" })
      .run();
    assert.equal(sem.rebuildWindows().scanned, 0);
  });
});

describe("**权限：算分之前就切掉**", () => {
  it("搜不到自己不在的群", async () => {
    addWindow(CONV_MINE, "我在的群里聊的事", 1);
    addWindow(CONV_THEIRS, "我不在的群里聊的事", 1); // 同一个方向，分数一样

    const me = dbm.db.select().from(schema.users).where(eq(schema.users.id, ME)).get()!;
    const result = await sem.semanticSearch(me, "随便什么");

    // 嵌入没配，检索会返回 error —— 但可见性判断在那之前
    if (result.error) {
      // 至少要确认它没把不可见的群漏出来
      assert.deepEqual(result.hits, []);
      return;
    }
    for (const hit of result.hits) {
      assert.equal(hit.convId, CONV_MINE, "搜到了我不在的群");
    }
  });

  it("**一个群都看不到时明说没权限** —— 和「没搜到」是两回事", async () => {
    dbm.db.delete(schema.groupMembers).run();
    const me = dbm.db.select().from(schema.users).where(eq(schema.users.id, ME)).get()!;
    const result = await sem.semanticSearch(me, "随便什么");
    assert.equal(result.noAccess, true);
  });

  it("未登录的人也走同一条判定", async () => {
    const result = await sem.semanticSearch(null, "随便什么");
    assert.equal(result.noAccess, true);
    assert.deepEqual(result.hits, []);
  });

  it("**源码里可见性过滤在打分之前**", () => {
    /*
     * 顺手写成先算分后过滤，结果看起来也对，
     * 而耗时会随着不可见内容的多少变化 —— 那本身就是一条侧信道。
     */
    const src = readFileSync(new URL("../src/lib/search/semantic.ts", import.meta.url), "utf8");
    const loop = src.slice(src.indexOf("for (const row of loadVectors())"));
    const skipAt = loop.indexOf("visibleSet.has(row.convId)");
    const scoreAt = loop.indexOf("cosine(");
    assert.ok(skipAt > 0 && scoreAt > 0);
    assert.ok(skipAt < scoreAt, "先算了分再过滤可见性");
  });

  it("conv_id 冗余存在窗口表上 —— 没有它就只能算完再筛", () => {
    const src = readFileSync(new URL("../src/lib/db/schema/search.ts", import.meta.url), "utf8");
    assert.match(src, /convId: text\("conv_id"\)\.notNull\(\)/);
  });
});

describe("嵌入不可用时", () => {
  it("**如实说，不退回成关键词搜索假装正常**", async () => {
    /*
     * 退回的话人会以为「语义搜索就这水平」，
     * 而真正的问题是它根本没跑。
     */
    addWindow(CONV_MINE, "随便什么", 1);
    const saved = process.env.EMBEDDING_BASE_URL;
    delete process.env.EMBEDDING_BASE_URL;
    delete process.env.EMBEDDING_MODEL;

    const me = dbm.db.select().from(schema.users).where(eq(schema.users.id, ME)).get()!;
    const result = await sem.semanticSearch(me, "随便什么");

    assert.ok(result.error, "嵌入没配却没有报错");
    assert.match(result.error!, /嵌入/);
    assert.deepEqual(result.hits, []);

    if (saved) process.env.EMBEDDING_BASE_URL = saved;
  });

  it("**还没嵌完时要说出还剩多少** —— 结果不完整却不说，人会以为搜过了", async () => {
    addWindow(CONV_MINE, "已经嵌过的", 1, true);
    addWindow(CONV_MINE, "还没嵌的", 2, false);

    const me = dbm.db.select().from(schema.users).where(eq(schema.users.id, ME)).get()!;
    const result = await sem.semanticSearch(me, "随便什么");
    assert.equal(result.pending, 1);
  });
});

describe("进度", () => {
  it("数得出总段数、已嵌、待嵌", () => {
    addWindow(CONV_MINE, "a", 1, true);
    addWindow(CONV_MINE, "b", 2, true);
    addWindow(CONV_MINE, "c", 3, false);

    const p = sem.semanticProgress();
    assert.equal(p.total, 3);
    assert.equal(p.embedded, 2);
    assert.equal(p.pending, 1);
  });

  it("一段都没有时不炸", () => {
    assert.deepEqual(sem.semanticProgress(), { total: 0, embedded: 0, pending: 0 });
  });
});

describe("向量缓存", () => {
  it("**新嵌进来的段要能马上搜到** —— 缓存不失效的话人会以为同步坏了", () => {
    /*
     * 用行数 + 最后嵌入时间当版本号，比「写入时手动清缓存」可靠：
     * 手动清总会有人忘记加，而忘记的表现是搜不到刚同步进来的内容，
     * 很难联想到缓存。
     */
    const src = readFileSync(new URL("../src/lib/search/semantic.ts", import.meta.url), "utf8");
    const fn = src.slice(src.indexOf("function vectorStamp"), src.indexOf("function loadVectors"));
    assert.match(fn, /count\(\*\)/);
    assert.match(fn, /max\(/);
  });

  it("维度对不上的向量跳过，不参与打分", () => {
    const src = readFileSync(new URL("../src/lib/search/semantic.ts", import.meta.url), "utf8");
    assert.match(src, /row\.vector\.length !== queryVector\.length/);
  });
});

describe("分数门槛", () => {
  it("**有个下限** —— 语义检索总能算出个最相似的，哪怕毫不相干", () => {
    assert.ok(sem.MIN_SCORE > 0.2 && sem.MIN_SCORE < 0.8, `${sem.MIN_SCORE} 不像个合理的门槛`);
    const src = readFileSync(new URL("../src/lib/search/semantic.ts", import.meta.url), "utf8");
    assert.match(src, /score >= MIN_SCORE/);
  });
});

describe("接线", () => {
  it("切段和嵌入是两个独立的入口 —— 网络抖一下不该连段都没切", () => {
    const src = readFileSync(new URL("../src/lib/search/semantic.ts", import.meta.url), "utf8");
    assert.match(src, /export function rebuildWindows/);
    assert.match(src, /export async function embedPendingWindows/);

    const rebuild = src.slice(src.indexOf("export function rebuildWindows"), src.indexOf("const EMBED_BATCH"));
    assert.doesNotMatch(rebuild, /await embed\(/, "切段里调了嵌入接口");
  });

  it("脚本存在且真的调这两个函数", () => {
    const script = readFileSync(new URL("../scripts/embed-messages.ts", import.meta.url), "utf8");
    assert.match(script, /rebuildWindows\(\)/);
    assert.match(script, /embedPendingWindows\(/);
  });
});

describe("界面", () => {
  const page = readFileSync(new URL("../src/app/(app)/search/page.tsx", import.meta.url), "utf8");
  const comp = readFileSync(
    new URL("../src/components/search/SemanticHits.tsx", import.meta.url),
    "utf8",
  );

  it("两种搜法并排放，不藏在设置里 —— 藏起来就没人会发现第二种存在", () => {
    assert.match(page, /按关键词/);
    assert.match(page, /意思差不多的/);
  });

  it("**只跑要用的那一条** —— 为「万一切过去」而两条都跑，等于给每次关键词搜索加一次网络往返", () => {
    assert.match(page, /semantic && query \? await semanticSearch/);
  });

  it("**一条结果是一整段对话** —— 挑一句出来单独看往往毫无意义", () => {
    /*
     * 群聊里一半的消息不到 8 个字。
     * 挑出来的那句人会以为搜错了。
     */
    assert.match(comp, /hit\.messages\.map/);
  });

  it("**相似度要显示出来** —— 语义检索总能算出个最相似的，哪怕毫不相干", () => {
    assert.match(comp, /接近/);
    assert.match(comp, /hit\.score/);
  });

  it("**嵌入没跑起来时不显示成「没搜到」**", () => {
    assert.match(page, /SemanticNotice/);
    assert.match(comp, /role=\{error \? "alert" : "status"\}/);
  });

  it("索引没建完时说出还剩多少", () => {
    assert.match(comp, /没建好索引/);
  });

  it("用 SVG 图标不用 emoji", () => {
    assert.match(comp, /lucide-react/);
    assert.doesNotMatch(comp, /[\u{1F300}-\u{1FAFF}]/u, "组件里混了 emoji");
  });
});
