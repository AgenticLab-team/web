import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readCode } from "./_source";

import {
  buildRagPrompt,
  parseRagResponse,
  stripUnknownMarkers,
  validCitations,
  type RagSource,
} from "@/lib/search/rag-rules";

/**
 * 群聊问答的规则层。
 *
 * ─────────────────────────────────────────
 * 这个功能最坏的形态是「答得很好，但那件事群里没发生过」
 * ─────────────────────────────────────────
 *
 * 模型自己就知道 MCP 鉴权怎么做。问它「群里讨论过 MCP 鉴权吗」，
 * 它会顺手把自己知道的答出来，再挑几条沾边的消息当引用 ——
 * 看起来完美，而**那场讨论根本没发生过**。
 *
 * 那比答不出来糟得多：答不出来的时候人会自己去搜；
 * 答错了的时候人会拿着一个不存在的结论去跟群里的人对话。
 *
 * 提示词只是**请求**模型别这么干。下面测的是**拒收**：
 * 没有出处的回答不作数、编号对不上的引用一律丢掉。
 * 那几条比任何提示词都管用。
 */

const sources: RagSource[] = [
  { index: 1, messageId: "m1", convId: "g1", date: "2026-08-01", text: "A：用 X\nB：好" },
  { index: 2, messageId: "m2", convId: "g1", date: "2026-08-02", text: "C：X 有坑" },
  { index: 3, messageId: "m3", convId: "g2", date: "2026-08-03", text: "D：换 Y" },
];

const answered = (answer: string, cites: number[]) =>
  ({ kind: "answer" as const, answer, cites });

describe("提示词", () => {
  it("材料按编号排好，模型才标得出出处", () => {
    const [, user] = buildRagPrompt("群里聊过 X 吗", sources);
    assert.match(user.content, /\[1\]/);
    assert.match(user.content, /\[2\]/);
    assert.match(user.content, /\[3\]/);
    assert.match(user.content, /群里聊过 X 吗/);
  });

  it("**日期要给模型** —— 「上周说的」这类问题全靠它", () => {
    const [, user] = buildRagPrompt("最近怎么说的", sources);
    assert.match(user.content, /2026-08-01/);
  });

  it("**系统提示里写死了「只依据材料」**", () => {
    const [system] = buildRagPrompt("q", sources);
    assert.match(system.content, /只依据材料回答/);
    assert.match(system.content, /你自己知道的东西一个字都不要写进来/);
  });

  it("**要求把分歧写出来** —— 一个干净的答案会掩盖群里的争论", () => {
    const [system] = buildRagPrompt("q", sources);
    assert.match(system.content, /分歧/);
  });
});

describe("解析", () => {
  it("正常回答", () => {
    const out = parseRagResponse('{"found":true,"answer":"群里说用 X[1]","cites":[1]}');
    assert.equal(out.kind, "answer");
    if (out.kind !== "answer") return;
    assert.equal(out.answer, "群里说用 X[1]");
    assert.deepEqual(out.cites, [1]);
  });

  it("**没聊过是正常结果，不是故障**", () => {
    const out = parseRagResponse('{"found":false,"reason":"检索到的都在讲部署"}');
    assert.equal(out.kind, "not-found");
    if (out.kind !== "not-found") return;
    assert.match(out.reason, /部署/);
  });

  it("**一条出处都没标的回答，当成没答上**", () => {
    /*
     * 这正是模型在拿自己知道的东西作答的样子：答得很流畅，
     * 却标不出是从哪一段来的 —— 因为确实不是从材料里来的。
     *
     * 提示词是请求，这一条是拒收。它比提示词管用得多。
     */
    const out = parseRagResponse('{"found":true,"answer":"一般来说应该用 OAuth","cites":[]}');
    assert.equal(out.kind, "not-found");
  });

  it("**cites 字段整个缺失也当成没答上**", () => {
    const out = parseRagResponse('{"found":true,"answer":"应该用 OAuth"}');
    assert.equal(out.kind, "not-found");
  });

  it("**代码块围栏要剥掉** —— 不剥的话全军覆没，会被误读成模型不可用", () => {
    const out = parseRagResponse('```json\n{"found":true,"answer":"用 X[1]","cites":[1]}\n```');
    assert.equal(out.kind, "answer");
  });

  it("JSON 前后带一句话也认", () => {
    const out = parseRagResponse('好的，我看了一下：\n{"found":true,"answer":"用 X[1]","cites":[1]}\n希望有帮助');
    assert.equal(out.kind, "answer");
  });

  it("**真的解析不了才报故障**", () => {
    assert.equal(parseRagResponse("我觉得群里没聊过这个").kind, "unparsable");
    assert.equal(parseRagResponse("").kind, "unparsable");
    assert.equal(parseRagResponse("{坏的 json").kind, "unparsable");
  });

  it("**空回答当解析失败**，不是当成一个空答案", () => {
    assert.equal(parseRagResponse('{"found":true,"answer":"   ","cites":[1]}').kind, "unparsable");
  });

  it("cites 里的脏数据被滤掉", () => {
    const out = parseRagResponse('{"found":true,"answer":"用 X[1]","cites":[1,"2",null,-3,1.5]}');
    assert.equal(out.kind, "answer");
    if (out.kind !== "answer") return;
    assert.deepEqual(out.cites, [1]);
  });

  it("重复的编号只留一个", () => {
    const out = parseRagResponse('{"found":true,"answer":"x[1][1]","cites":[1,1,2]}');
    assert.equal(out.kind, "answer");
    if (out.kind !== "answer") return;
    assert.deepEqual(out.cites, [1, 2]);
  });
});

describe("引用校验", () => {
  it("**模型编出来的编号丢掉**", () => {
    /*
     * 给了 3 段材料，模型标个 [11] 出来 —— 这是常见行为。
     * 不校验的话界面上会出现一个点不开的引用，
     * 而人会以为是自己没找到，不会想到它根本不存在。
     */
    assert.deepEqual(validCitations(answered("看 [11]", [11]), sources), []);
    assert.deepEqual(validCitations(answered("看 [1] 和 [99]", [1, 99]), sources), [1]);
  });

  it("**正文里标了、cites 漏了的，补进来** —— 人读的是正文", () => {
    assert.deepEqual(validCitations(answered("A 说[1]，B 反对[2]", [1]), sources), [1, 2]);
  });

  it("**cites 里有、正文没标的也算** —— 两边取并集", () => {
    assert.deepEqual(validCitations(answered("群里聊过", [2]), sources), [2]);
  });

  it("结果去重且有序", () => {
    assert.deepEqual(validCitations(answered("[3][1][3]", [1, 3]), sources), [1, 3]);
  });

  it("**没有材料时什么都引不出来**", () => {
    assert.deepEqual(validCitations(answered("[1]", [1]), []), []);
  });
});

describe("清掉无效标记", () => {
  it("**指向不存在编号的标记要从正文里去掉**", () => {
    /*
     * 留着的话，读的人会去找 [11]，找不到，然后不再相信别的引用 ——
     * 一个坏引用会连累所有好引用。
     */
    assert.equal(stripUnknownMarkers("A 说[1]，另外[11] 提过", sources), "A 说[1]，另外 提过");
  });

  it("有效的标记原样留着", () => {
    assert.equal(stripUnknownMarkers("A[1]、B[2]、C[3]", sources), "A[1]、B[2]、C[3]");
  });

  it("没有标记时原样返回", () => {
    assert.equal(stripUnknownMarkers("群里聊过这个", sources), "群里聊过这个");
  });
});

describe("接线", () => {
  /*
   * 用 readCode 而不是原文 —— 它会剥掉注释。
   *
   * 第一版拿原文查「有没有出现 visibleGroupIds」，结果被**自己的
   * 文件头注释**判了红：那段注释正是在解释 semanticSearch 守着
   * 哪两条规矩。断言「代码里写了什么」时必须先去注释，
   * 否则解释得越清楚，越容易把自己测红。
   */
  const rag = readCode("lib/search/rag.ts");

  it("**检索层一行都不重写** —— 隔离规则只有 semanticSearch 一处实现", () => {
    /*
     * semanticSearch 守着两条这个功能最不能破的规矩：只搜这个人在的群、
     * 关掉「别人能搜到我」的人整段丢掉。自己再写一遍检索的话，
     * 这两条迟早分叉，而分叉的方向一定是更松的那一边泄露。
     */
    assert.match(rag, /await semanticSearch\(user, trimmed, MAX_SOURCES\)/);
    assert.equal(rag.includes("visibleGroupIds"), false, "自己又查了一遍可见的群");
    assert.equal(rag.includes("unsearchableWxIds"), false, "自己又查了一遍隐私名单");
    assert.equal(rag.includes("messageWindows"), false, "绕过检索层直接读了段落表");
  });

  it("**材料为空时根本不问模型**", () => {
    assert.match(rag, /if \(sources\.length === 0\)[\s\S]{0,200}kind: "not-found"/);
  });

  it("**校验后一条引用都不剩的回答不给出去**", () => {
    // 那种回答读起来最像真的 —— 编号全是编的
    assert.match(rag, /if \(cited\.length === 0\)/);
  });

  it("**只回被引用到的那几段**", () => {
    assert.match(rag, /citedSet\.has\(s\.source\.index\)/);
  });

  it("**温度压到底** —— 这不是创作，是复述群里说过的话", () => {
    assert.match(rag, /temperature: 0/);
  });

  it("**开关关掉时那一档直接不存在**，不是点了没反应", () => {
    /*
     * 一个点了没反应的标签比没有这个标签糟 ——
     * 这个站修死开关的时候反复撞见的就是这件事。
     */
    const page = readCode("app/(app)/search/page.tsx");
    assert.match(page, /const canAsk = featureEnabled\("rag_qa", user\)/);
    assert.match(page, /const asking = canAsk && params\.mode === "ask"/);
    assert.match(page, /\{canAsk && \(/);
  });

  it("**换档要重新挂起** —— 否则会拿另一档的旧结果充数", () => {
    const page = readCode("app/(app)/search/page.tsx");
    assert.match(page, /key=\{`ask:\$\{query\}`\}/);
  });

  it("**每条出处都能一步点回归档现场**", () => {
    const comp = readCode("components/search/RagAnswer.tsx");
    assert.match(comp, /\/archive\?group=\$\{encodeURIComponent\(source\.convId\)\}&m=/);
  });

  it("**界面上说明白这是机器写的**", () => {
    /*
     * 资源库那边给 AI 简介定的规矩一样：一个语气笃定的段落，
     * 人默认它是可靠的，得让他知道来源。
     */
    const comp = readCode("components/search/RagAnswer.tsx");
    assert.match(comp, /机器根据下面这几段群聊整理/);
  });

  it("**还有段落没嵌完时要说** —— 不说的话「没聊过」会被当成结论", () => {
    const comp = readCode("components/search/RagAnswer.tsx");
    assert.match(comp, /没进索引/);
  });

  it("**模型挂了要说挂了**，不能退回成「没找到」", () => {
    /*
     * 退回成「没找到」会让人以为群里没聊过，而实际上是这一侧坏了。
     * 两者的下一步完全不同：一个是去别处找，一个是修。
     */
    assert.match(rag, /kind: "unavailable"/);
    assert.match(rag, /LlmNotConfigured/);
  });
});
