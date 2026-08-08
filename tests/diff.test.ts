import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { collapseUnchanged, diffLines, diffStats } from "@/lib/diff";

describe("行级 diff", () => {
  it("完全相同时全是 same", () => {
    const lines = diffLines("a\nb\nc", "a\nb\nc");
    assert.ok(lines.every((l) => l.kind === "same"));
    assert.deepEqual(diffStats(lines), { added: 0, removed: 0 });
  });

  it("新增一行", () => {
    const lines = diffLines("a\nc", "a\nb\nc");
    assert.deepEqual(diffStats(lines), { added: 1, removed: 0 });
    assert.ok(lines.some((l) => l.kind === "add" && l.text === "b"));
  });

  it("删除一行", () => {
    const lines = diffLines("a\nb\nc", "a\nc");
    assert.deepEqual(diffStats(lines), { added: 0, removed: 1 });
  });

  it("改一行 = 删一行加一行", () => {
    const lines = diffLines("a\nb\nc", "a\nB\nc");
    assert.deepEqual(diffStats(lines), { added: 1, removed: 1 });
  });

  it("从空到有内容", () => {
    assert.deepEqual(diffStats(diffLines("", "a\nb")), { added: 2, removed: 1 });
  });

  it("保持原有顺序，未改动的行仍在原位", () => {
    const lines = diffLines("头\n中\n尾", "头\n新\n尾");
    assert.equal(lines[0].kind, "same");
    assert.equal(lines[0].text, "头");
    assert.equal(lines[lines.length - 1].text, "尾");
  });
});

describe("折叠未改动段落", () => {
  it("大段未改动被折叠成一个 gap", () => {
    // 两千字的帖子改一个错别字，全文对照没人看得下去
    const before = Array.from({ length: 40 }, (_, i) => `行${i}`).join("\n");
    const after = before.replace("行20", "行二十");
    const collapsed = collapseUnchanged(diffLines(before, after), 2);

    const gaps = collapsed.filter((l) => l.kind === "gap");
    assert.ok(gaps.length >= 2, "改动处前后应各有一个折叠段");
    assert.ok(collapsed.length < 40, `折叠后应显著变短，实际 ${collapsed.length} 行`);
  });

  it("改动处上下文被保留", () => {
    const before = "1\n2\n3\n4\n5\n6\n7\n8\n9";
    const after = "1\n2\n3\n4\nX\n6\n7\n8\n9";
    const collapsed = collapseUnchanged(diffLines(before, after), 2);
    const texts = collapsed.filter((l) => l.kind !== "gap").map((l) => (l as { text: string }).text);
    assert.ok(texts.includes("3"), "改动前两行应保留");
    assert.ok(texts.includes("7"), "改动后两行应保留");
  });

  it("全文都改了就不折叠", () => {
    const collapsed = collapseUnchanged(diffLines("a\nb", "x\ny"), 2);
    assert.equal(collapsed.filter((l) => l.kind === "gap").length, 0);
  });
});
