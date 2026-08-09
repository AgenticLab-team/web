import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  MIN_WINDOW_CHARS,
  WINDOW_GAP_MS,
  WINDOW_MAX_CHARS,
  WINDOW_MAX_MESSAGES,
  blobToVector,
  buildWindows,
  cosine,
  vectorToBlob,
  windowKey,
  type WindowInput,
} from "@/lib/search/windows";

/**
 * 会话窗口切段。
 *
 * ─────────────────────────────────────────
 * 这一层存在的理由是一组数字
 * ─────────────────────────────────────────
 *
 * 生产上数过：一半的群消息不超过 8 个字，78% 不超过 15 字。
 * 「哈哈」「好的」「+1」单独拿去嵌入，向量彼此都差不多 ——
 * 既召不回想要的，又会把语气词排到前面。
 *
 * 做出来会像能用，实际每次都答非所问，而那比没有这个功能更糟：
 * 人会以为搜过了。
 */

let seq = 0;
const msg = (o: Partial<WindowInput> = {}): WindowInput => ({
  id: `m${seq++}`,
  convId: "room_a",
  ts: 1_000_000,
  senderName: "甲",
  content: "这是一句足够长的话，能过最短长度",
  ...o,
});

describe("按停顿切段", () => {
  it("间隔小的连成一段", () => {
    const windows = buildWindows([
      msg({ ts: 1000 }),
      msg({ ts: 1000 + 60_000 }),
      msg({ ts: 1000 + 120_000 }),
    ]);
    assert.equal(windows.length, 1);
    assert.equal(windows[0].messageIds.length, 3);
  });

  it("**停顿超过门槛就断开** —— 群聊的话题切换基本都伴随一段沉默", () => {
    const windows = buildWindows([
      msg({ ts: 1000 }),
      msg({ ts: 1000 + WINDOW_GAP_MS + 1 }),
    ]);
    assert.equal(windows.length, 2);
  });

  it("刚好等于门槛还算同一段 —— 边界不该两边都断", () => {
    const windows = buildWindows([msg({ ts: 1000 }), msg({ ts: 1000 + WINDOW_GAP_MS })]);
    assert.equal(windows.length, 1);
  });

  it("**换群一定断开** —— 两个群的对话拼在一个向量里毫无意义", () => {
    const windows = buildWindows([
      msg({ convId: "room_a", ts: 1000 }),
      msg({ convId: "room_b", ts: 1001 }),
    ]);
    assert.equal(windows.length, 2);
    assert.deepEqual(windows.map((w) => w.convId), ["room_a", "room_b"]);
  });

  it("起止时间取这一段的首尾", () => {
    const windows = buildWindows([
      msg({ ts: 1000 }),
      msg({ ts: 5000 }),
      msg({ ts: 9000 }),
    ]);
    assert.equal(windows[0].startTs, 1000);
    assert.equal(windows[0].endTs, 9000);
  });

  it("空输入不炸", () => {
    assert.deepEqual(buildWindows([]), []);
  });
});

describe("按长度切段", () => {
  it("**太长要断，即使没有停顿** —— 几个话题揉进一个向量，哪个都不像", () => {
    const long = "字".repeat(500);
    const windows = buildWindows([
      msg({ ts: 1000, content: long }),
      msg({ ts: 2000, content: long }),
      msg({ ts: 3000, content: long }),
    ]);
    assert.ok(windows.length >= 2, `只切出 ${windows.length} 段`);
    for (const w of windows) {
      assert.ok(w.text.length <= WINDOW_MAX_CHARS + 600, "有一段长得离谱");
    }
  });

  it("条数太多也断 —— 防止刷屏把一段撑爆", () => {
    const many = Array.from({ length: WINDOW_MAX_MESSAGES + 5 }, (_, i) =>
      msg({ ts: 1000 + i * 1000, content: "短" }),
    );
    const windows = buildWindows(many);
    assert.ok(windows.length >= 2);
    for (const w of windows) {
      assert.ok(w.messageIds.length <= WINDOW_MAX_MESSAGES);
    }
  });
});

describe("**太短的段不要**", () => {
  it("一段只有「哈哈」的对话直接丢掉", () => {
    /*
     * 给它算个向量只会在结果里占位置 ——
     * 而这种段在群聊里占了一半。
     */
    const windows = buildWindows([msg({ content: "哈哈" })]);
    assert.deepEqual(windows, []);
  });

  it("几条短消息凑够长度就留下 —— 这正是切段的意义", () => {
    const windows = buildWindows([
      msg({ ts: 1000, content: "有人用过那个吗" }),
      msg({ ts: 2000, content: "我试过，还行" }),
      msg({ ts: 3000, content: "贵不贵" }),
    ]);
    assert.equal(windows.length, 1, "三条加起来够长了却被丢掉");
  });

  it("空白不算长度 —— 一堆换行凑不出内容", () => {
    const windows = buildWindows([msg({ content: "  \n  \n  " })]);
    assert.deepEqual(windows, []);
    assert.ok(MIN_WINDOW_CHARS > 0);
  });
});

describe("拼出来的文本", () => {
  it("**带说话人** —— 不带的话「谁说的」这类问题永远搜不到", () => {
    const windows = buildWindows([
      msg({ senderName: "张三", content: "这个方案我觉得可以先试试" }),
      msg({ senderName: "李四", content: "那我周末先搭个原型出来" }),
    ]);
    assert.match(windows[0].text, /张三/);
    assert.match(windows[0].text, /李四/);
  });

  it("一条一行，顺序和原文一致", () => {
    const windows = buildWindows([
      msg({ ts: 1000, content: "第一句话要够长才留得下" }),
      msg({ ts: 2000, content: "第二句话也要够长才行" }),
    ]);
    const lines = windows[0].text.split("\n");
    assert.ok(lines[0].includes("第一句"));
    assert.ok(lines[1].includes("第二句"));
  });
});

describe("**输入没排序要如实抛**", () => {
  it("同一个群里时间倒着来 —— 抛错，不要替它兜住", () => {
    /*
     * 调用方是从 SQL 里 ORDER BY 出来的。如果没排序，
     * 说明它拿错了数据 —— 这里替它兜住只会把那个错误藏起来，
     * 而藏起来的表现是「切出来的段莫名其妙」，没人查得到根因。
     */
    assert.throws(
      () => buildWindows([msg({ ts: 5000 }), msg({ ts: 1000 })]),
      /没有按时间排序/,
    );
  });

  it("不同群之间的时间不要求有序 —— 那是按群分组排的正常结果", () => {
    assert.doesNotThrow(() =>
      buildWindows([msg({ convId: "a", ts: 9000 }), msg({ convId: "b", ts: 1000 })]),
    );
  });
});

describe("**段的标识要稳定**", () => {
  it("重跑切段时同一段认得出来 —— 否则每次同步都会把整个语料重嵌一遍", () => {
    const input = [msg({ id: "first", ts: 1000 }), msg({ id: "second", ts: 2000 })];
    const a = buildWindows(input);
    const b = buildWindows(input);
    assert.equal(windowKey(a[0]), windowKey(b[0]));
    assert.match(windowKey(a[0]), /first/);
  });

  it("不同群的同一条 id 不会撞", () => {
    const a = buildWindows([
      msg({ id: "x", convId: "room_a", ts: 1000 }),
      msg({ id: "y", convId: "room_a", ts: 2000 }),
    ]);
    const b = buildWindows([
      msg({ id: "x", convId: "room_b", ts: 1000 }),
      msg({ id: "y", convId: "room_b", ts: 2000 }),
    ]);
    assert.notEqual(windowKey(a[0]), windowKey(b[0]));
  });
});

describe("余弦相似度", () => {
  it("自己和自己是 1", () => {
    const v = new Float32Array([1, 2, 3]);
    assert.ok(Math.abs(cosine(v, v) - 1) < 1e-6);
  });

  it("正交是 0", () => {
    assert.ok(Math.abs(cosine(new Float32Array([1, 0]), new Float32Array([0, 1]))) < 1e-6);
  });

  it("方向相反是 -1", () => {
    assert.ok(Math.abs(cosine(new Float32Array([1, 0]), new Float32Array([-1, 0])) + 1) < 1e-6);
  });

  it("**不假设向量归一化过** —— 长度不同但方向一样，相似度还是 1", () => {
    /*
     * 不同嵌入模型的输出不一样。假设归一化过而实际没有的话，
     * 这个函数会悄悄退化成「按向量长度排序」—— 看起来完全正常。
     */
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([10, 20, 30]);
    assert.ok(Math.abs(cosine(a, b) - 1) < 1e-6);
  });

  it("零向量返回 0，不返回 NaN", () => {
    assert.equal(cosine(new Float32Array([0, 0]), new Float32Array([1, 1])), 0);
  });

  it("维度对不上要抛 —— 换了模型没重嵌，静默算出来的分数毫无意义", () => {
    assert.throws(
      () => cosine(new Float32Array([1, 2]), new Float32Array([1, 2, 3])),
      /维度对不上/,
    );
  });
});

describe("向量存进 SQLite 再取出来", () => {
  it("原样回来", () => {
    const v = new Float32Array([0.1, -0.25, 3.5, 0]);
    const back = blobToVector(vectorToBlob(v));
    assert.equal(back.length, v.length);
    for (let i = 0; i < v.length; i++) assert.ok(Math.abs(back[i] - v[i]) < 1e-6);
  });

  it("**取出来是独立的一份** —— 共享底层内存会读到隔壁的数据", () => {
    /*
     * better-sqlite3 返回的 Buffer 可能落在一块共享的 ArrayBuffer 上，
     * 偏移量不一定是 4 的倍数 —— 直接当 Float32Array 用会抛，
     * 或者更糟：读到别的行的向量，而分数看起来仍然「正常」。
     */
    const v = new Float32Array([1, 2, 3]);
    const blob = vectorToBlob(v);
    const back = blobToVector(blob);
    back[0] = 99;
    assert.equal(blobToVector(blob)[0], 1, "改了取出来的那份，原始 blob 也跟着变了");
  });

  it("非 4 字节对齐的 Buffer 也能读 —— 这是真会发生的情况", () => {
    const v = new Float32Array([1.5, 2.5]);
    const padded = Buffer.concat([Buffer.from([0]), vectorToBlob(v)]);
    const offset = padded.subarray(1);
    const back = blobToVector(offset);
    assert.ok(Math.abs(back[0] - 1.5) < 1e-6);
    assert.ok(Math.abs(back[1] - 2.5) < 1e-6);
  });

  it("空向量不炸", () => {
    assert.equal(blobToVector(vectorToBlob(new Float32Array([]))).length, 0);
  });
});

describe("这一层不碰 IO", () => {
  it("纯函数 —— 切段规则要能密集测试", () => {
    const src = readFileSync(new URL("../src/lib/search/windows.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*/g, "");
    for (const forbidden of ["server-only", "@/lib/db", "drizzle-orm", "fetch("]) {
      assert.equal(src.includes(forbidden), false, `切段层引了 ${forbidden}`);
    }
  });
});
