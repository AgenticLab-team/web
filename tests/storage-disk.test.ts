import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * 磁盘那一行。
 *
 * ─────────────────────────────────────────
 * 数一直在存，页面一直只显示百分比
 * ─────────────────────────────────────────
 *
 * `storage_snapshots` 里的 `disk_total` / `disk_used` 每次探测都写，
 * 763 条快照一条不落 —— 而存储那一页显示的是 `磁盘 16%`。
 *
 * 一个百分比答不了「还能撑多久」，也答不了「清一次能腾出多少」，
 * 而这两个问题正是有人打开这一页的原因。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

describe("**绝对值要露出来**", () => {
  const q = strip(src("lib/storage/queries.ts"));
  const page = strip(src("app/(app)/admin/storage/page.tsx"));

  it("查询层把两个数带出来了", () => {
    assert.match(q, /totalBytes: snapshot\.diskTotal/);
    assert.match(q, /usedBytes: snapshot\.diskUsed/);
  });

  it("**剩余是算出来的，不再存一份** —— 存三个数迟早有一天对不上", () => {
    assert.match(q, /freeBytes: Math\.max\(0, snapshot\.diskTotal - snapshot\.diskUsed\)/);
  });

  it("页面把三个都显示了", () => {
    for (const field of ["usedBytes", "totalBytes", "freeBytes"]) {
      assert.match(page, new RegExp(`formatBytes\\(s\\.disk\\.${field}\\)`), field);
    }
  });

  it("百分比也还在 —— 阈值是按百分比定的，两个都要有", () => {
    assert.match(page, /s\.disk\.pct/);
  });
});
