import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { stripComments as strip } from "./_source";

/**
 * 从搜索结果到那条消息的路。
 *
 * ─────────────────────────────────────────
 * 「我想找消息，不能快速引用」
 * ─────────────────────────────────────────
 *
 * 找到一条之后要拿它去整理成帖子，以前得走三步：
 * 跳到按天回看 → 在几千条里重新找到它 → 点那儿的引用。
 * **而搜索本来就是为了少走路。**
 *
 * 语义检索那一路更彻底：它**没有任何一条路通向那段消息本身** ——
 * 看到一段觉得有用的对话，只能自己记住群名和时间再去翻。
 * 而这一页存在的理由就是「找到它」。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

describe("**关键词检索：两个出口**", () => {
  const hits = strip(src("components/search/MessageHitList.tsx"));

  it("能跳到群聊记录", () => {
    assert.match(hits, /messageLink\(hit\.id, \{ convId: hit\.convId \}\)/);
  });

  it("**能直接引用** —— 不用先跳过去再找一遍", () => {
    assert.match(hits, /messageLink\(hit\.id, \{ convId: hit\.convId \}, "\/forum\/convert"\)/);
  });

  it("**论坛关掉时不给这个入口** —— 点进去是个 404", () => {
    assert.match(hits, /canQuote &&/);
  });

  it("引用按钮有说得清的无障碍标签", () => {
    // 「引用」两个字单独放出来，读屏用户不知道引用的是哪一条
    assert.match(hits, /aria-label=\{`引用 \$\{hit\.senderName\}/);
  });
});

describe("**语义检索：以前一个出口都没有**", () => {
  const semantic = strip(src("components/search/SemanticHits.tsx"));

  it("能跳到群聊记录", () => {
    assert.match(semantic, /messageLink\(first\(hit\)!\.id, \{ convId: hit\.convId \}\)/);
  });

  it("能引用", () => {
    assert.match(semantic, /"\/forum\/convert"/);
  });

  it("**锚在这一段的第一条上** —— 段是模型切的，人要从头读", () => {
    assert.match(semantic, /function first\(hit: SemanticHit\)/);
    assert.match(semantic, /sort\(\(a, b\) => a\.ts - b\.ts\)\[0\]/);
  });

  it("**没有消息的段不画那一行** —— 空段点进去是个死链", () => {
    assert.match(semantic, /\{first\(hit\) && \(/);
  });

  it("论坛关掉时同样不给引用", () => {
    assert.match(semantic, /canQuote &&/);
  });
});

describe("接线", () => {
  const page = strip(src("app/(app)/search/page.tsx"));

  it("两处都按功能开关传 canQuote", () => {
    const uses = page.match(/canQuote=\{featureEnabled\("forum", user\)\}/g) ?? [];
    assert.equal(uses.length, 2, "关键词和语义两路都要传");
  });
});

describe("**分隔线用 hairline-t，不手拼 border**", () => {
  it("globals.css 里有这个工具类", () => {
    /*
     * 这一组本来只有 b 和 r。手拼 `border-t` 会得到一条 1px 的线，
     * 和旁边所有 0.5px 的分隔线粗细不一 —— 在高分屏上一眼看得出来。
     */
    const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
    assert.match(css, /\.hairline-t \{\s*box-shadow: inset 0 0\.5px 0 var\(--separator\);/);
  });

  it("语义结果那一行用的是它", () => {
    assert.match(strip(src("components/search/SemanticHits.tsx")), /hairline-t/);
  });
});
