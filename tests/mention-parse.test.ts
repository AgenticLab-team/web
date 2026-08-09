import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  extractMentionTokens,
  resolveMentions,
  type RosterEntry,
} from "@/lib/messages/mentions";

/**
 * @提及 解析的纯函数测试。
 *
 * 测试样例的形态来自生产数据实测（2026-08-08，本地镜像 3,243 条含 @ 的消息）：
 * 微信原生 @ 以 U+2005 收尾、昵称可含普通空格、手打 @ 没有定界符、
 * 接龙里的 "jmr@nothing" 是邮箱式后缀不是提及。
 */

// U+2005 写成转义 —— 裸字符在编辑器里和普通空格无法区分，
// 出了问题没法用肉眼排查（同 BUCKET_KEY_SEP 的教训）
const SEP = " ";

function roster(
  entries: Array<Partial<RosterEntry> & { wxId: string }>,
): RosterEntry[] {
  return entries.map((e) => ({
    displayName: null,
    wxName: null,
    aliases: [],
    joinedAt: null,
    leftAt: null,
    ...e,
  }));
}

describe("词法提取", () => {
  it("U+2005 定界的 @ 取出精确昵称", () => {
    const tokens = extractMentionTokens(`@jmr${SEP}在门口摆个摊`);
    assert.equal(tokens.length, 1);
    assert.deepEqual(tokens[0], { name: "jmr", position: 0, delimited: true });
  });

  it("昵称本身可以含普通空格", () => {
    const tokens = extractMentionTokens(`你问 @Carleight Wu${SEP}吧`);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].name, "Carleight Wu");
    assert.equal(tokens[0].delimited, true);
  });

  it("邮箱式的 @ 不是提及（接龙里的 jmr@nothing）", () => {
    assert.deepEqual(extractMentionTokens("1. jmr@nothing"), []);
  });

  it("行尾孤零零的 @ 不是提及", () => {
    const records = resolveMentions("看一下 @", roster([]));
    assert.deepEqual(records, []);
  });

  it("一条消息里的多个 @ 都能取到，位置正确", () => {
    const content = `@甲${SEP}和 @乙${SEP}都来`;
    const tokens = extractMentionTokens(content);
    assert.equal(tokens.length, 2);
    assert.equal(content.slice(tokens[0].position, tokens[0].position + 2), "@甲");
    assert.equal(content.slice(tokens[1].position, tokens[1].position + 2), "@乙");
  });
});

describe("名册归属", () => {
  it("群备注名精确命中", () => {
    const r = roster([{ wxId: "wxid_a", displayName: "土豆", wxName: "potato" }]);
    const [m] = resolveMentions(`@土豆${SEP}在吗`, r);
    assert.equal(m.status, "resolved");
    assert.equal(m.wxId, "wxid_a");
  });

  it("没设群备注名时用微信昵称命中", () => {
    const r = roster([{ wxId: "wxid_a", wxName: "potato" }]);
    const [m] = resolveMentions(`@potato${SEP}hi`, r);
    assert.equal(m.status, "resolved");
    assert.equal(m.wxId, "wxid_a");
  });

  it("设了群备注名的人，用微信昵称 @ 也能命中（次级匹配）", () => {
    const r = roster([{ wxId: "wxid_a", displayName: "土豆", wxName: "potato" }]);
    const [m] = resolveMentions(`@potato${SEP}hi`, r);
    assert.equal(m.status, "resolved");
    assert.equal(m.wxId, "wxid_a");
  });

  it("曾用名能接住改名前的老消息", () => {
    const r = roster([
      { wxId: "wxid_a", displayName: "新名字", aliases: ["旧名字"] },
    ]);
    const [m] = resolveMentions(`@旧名字${SEP}看看这个`, r);
    assert.equal(m.status, "resolved");
    assert.equal(m.wxId, "wxid_a");
  });

  it("名册对不上时如实标 unknown，不挑最像的", () => {
    const r = roster([{ wxId: "wxid_a", displayName: "土豆丝" }]);
    const [m] = resolveMentions(`@土豆${SEP}在吗`, r);
    assert.equal(m.status, "unknown");
    assert.equal(m.wxId, null);
    // 字面昵称要留下来当证据
    assert.equal(m.name, "土豆");
  });

  it("@所有人 标成 all，不归属到任何人", () => {
    const r = roster([{ wxId: "wxid_a", displayName: "所有人" }]);
    const [m] = resolveMentions(`@所有人${SEP}开会了`, r);
    assert.equal(m.status, "all");
    assert.equal(m.wxId, null);
  });

  it("英文界面的 @Mention All 也是 all（生产实测形态）", () => {
    const [m] = resolveMentions(`@Mention All${SEP}开会`, roster([]));
    assert.equal(m.status, "all");
  });

  it("没有定界符的 @所有人 也是 all，不落进 unknown", () => {
    const [m] = resolveMentions("@所有人 开会了", roster([]));
    assert.equal(m.status, "all");
    // 但成员昵称只是以 all 开头时不能误判
    const r = roster([{ wxId: "wxid_allen", displayName: "Allen" }]);
    const [n] = resolveMentions("@Allen hi", r);
    assert.equal(n.status, "resolved");
    assert.equal(n.wxId, "wxid_allen");
  });
});

describe("同名歧义", () => {
  const twins = roster([
    { wxId: "wxid_a", displayName: "小明" },
    { wxId: "wxid_b", displayName: "小明" },
  ]);

  it("两个人同名 → ambiguous，候选都列出来，绝不选边", () => {
    const [m] = resolveMentions(`@小明${SEP}你来`, twins);
    assert.equal(m.status, "ambiguous");
    assert.equal(m.wxId, null);
    assert.deepEqual([...m.candidates].sort(), ["wxid_a", "wxid_b"]);
  });

  it("同名但其中一人当时还没入群 → 用时间排除后唯一命中", () => {
    const r = roster([
      { wxId: "wxid_a", displayName: "小明", joinedAt: 1000 },
      { wxId: "wxid_b", displayName: "小明", joinedAt: 9000 },
    ]);
    const [m] = resolveMentions(`@小明${SEP}你来`, r, 5000);
    assert.equal(m.status, "resolved");
    assert.equal(m.wxId, "wxid_a");
  });

  it("同名且当时都在群 → 仍是 ambiguous", () => {
    const r = roster([
      { wxId: "wxid_a", displayName: "小明", joinedAt: 1000 },
      { wxId: "wxid_b", displayName: "小明", joinedAt: 2000 },
    ]);
    const [m] = resolveMentions(`@小明${SEP}你来`, r, 5000);
    assert.equal(m.status, "ambiguous");
  });

  it("已退群的人的历史提及仍能命中（消息早于退群时间）", () => {
    const r = roster([{ wxId: "wxid_a", displayName: "老张", leftAt: 9000 }]);
    const [m] = resolveMentions(`@老张${SEP}在吗`, r, 5000);
    assert.equal(m.status, "resolved");
    assert.equal(m.wxId, "wxid_a");
  });
});

describe("手打 @（无定界符）", () => {
  const r = roster([
    { wxId: "wxid_m", displayName: "Meinianda" },
    { wxId: "wxid_j", displayName: "jmr" },
    { wxId: "wxid_j2", displayName: "jmr2" },
  ]);

  it("名册反推边界：@Meinianda 后面跟空格能命中", () => {
    const [m] = resolveMentions("下学期制裁 @Meinianda 中", r);
    assert.equal(m.status, "resolved");
    assert.equal(m.wxId, "wxid_m");
  });

  it("消息以 @昵称 结尾也能命中", () => {
    const [m] = resolveMentions("你问 @Meinianda", r);
    assert.equal(m.status, "resolved");
    assert.equal(m.wxId, "wxid_m");
  });

  it("取最长命中：@jmr2 认成 jmr2 而不是 jmr", () => {
    const [m] = resolveMentions("@jmr2 你好", r);
    assert.equal(m.status, "resolved");
    assert.equal(m.wxId, "wxid_j2");
  });

  it("收尾不干净不敢认：@jmrx 不是 @jmr", () => {
    const [m] = resolveMentions("@jmrx 你好", r);
    assert.equal(m.status, "unknown");
    assert.equal(m.wxId, null);
  });

  it("中文正文粘连时不敢认边界 → unknown", () => {
    const potato = roster([{ wxId: "wxid_p", displayName: "生土豆" }]);
    // 「@生土豆真好吃」可能是 @生土豆 说"真好吃"，也可能在 @ 一个叫
    // "生土豆真好吃" 的人 —— 无法确定就不确定
    const [m] = resolveMentions("@生土豆真好吃", potato);
    assert.equal(m.status, "unknown");
  });

  it("中文标点是干净边界：@生土豆，在吗 能命中", () => {
    const potato = roster([{ wxId: "wxid_p", displayName: "生土豆" }]);
    const [m] = resolveMentions("@生土豆，在吗", potato);
    assert.equal(m.status, "resolved");
    assert.equal(m.wxId, "wxid_p");
  });
});

describe("**他把群昵称的后缀改掉了**", () => {
  /*
   * 这一组是量出来的，不是想出来的。
   *
   * 生产库里 24 条对不上的 @ 有 9 条是同一个人：正文是 `@jmr@nothing`，
   * 而他今天在那个群叫 `jmr` —— 他把 `@nothing` 这个后缀去掉了。
   * 这 9 条全是站长自己的，也正是他看到「被 @ 是 0」的原因。
   *
   * 微信群昵称的惯例就是 `名字@单位`、`名字-城市`、`名字|职位`，
   * 而人换工作、换城市时改的正是后半截。
   */
  it("**`@jmr@nothing` 认得出今天叫 jmr 的那个人**", () => {
    const r = roster([{ wxId: "wxid_jmr", displayName: "jmr" }]);
    const [m] = resolveMentions(`@jmr@nothing${SEP}你要找的那个`, r);
    assert.equal(m.status, "resolved");
    assert.equal(m.wxId, "wxid_jmr");
    // 字面昵称要留着 —— 它是当时写的是什么的唯一证据
    assert.equal(m.name, "jmr@nothing");
  });

  it("横杠、竖线、括号这些分隔符一样认", () => {
    const r = roster([{ wxId: "wxid_m", displayName: "明立" }]);
    for (const suffix of ["-北京-AI教育", "|产品", "（腾讯）", "_zju"]) {
      const [m] = resolveMentions(`@明立${suffix}${SEP}在吗`, r);
      assert.equal(m.status, "resolved", suffix);
      assert.equal(m.wxId, "wxid_m", suffix);
    }
  });

  it("**`@李四` 不会被认成名册里的「李」**", () => {
    /*
     * 名字后面必须紧跟分隔符。少了这一条，任何一个短名字
     * 都会把所有以它开头的昵称吸过来。
     */
    const r = roster([{ wxId: "wxid_li", displayName: "李" }]);
    const [m] = resolveMentions(`@李四${SEP}在吗`, r);
    assert.equal(m.status, "unknown");
  });

  it("**一个字的名字不参与这条规则** —— 当前缀太容易撞", () => {
    const r = roster([{ wxId: "wxid_a", displayName: "A" }]);
    const [m] = resolveMentions(`@A@somewhere${SEP}在吗`, r);
    assert.equal(m.status, "unknown");
  });

  it("取最长的那个名字", () => {
    const r = roster([
      { wxId: "wxid_short", displayName: "jm" },
      { wxId: "wxid_long", displayName: "jmr" },
    ]);
    const [m] = resolveMentions(`@jmr@nothing${SEP}hi`, r);
    assert.equal(m.wxId, "wxid_long");
  });

  it("**两个人都对得上就一个都不认**", () => {
    /*
     * 认错人比认不出更糟：那条通知会送到一个完全无关的人手里，
     * 而他还以为有人在叫他。
     */
    const r = roster([
      { wxId: "wxid_1", displayName: "同名" },
      { wxId: "wxid_2", displayName: "同名" },
    ]);
    const [m] = resolveMentions(`@同名@某公司${SEP}hi`, r);
    assert.notEqual(m.status, "resolved");
    assert.equal(m.wxId, null);
  });

  it("**精确匹配优先** —— 真有人就叫这个全名时不许被前缀截走", () => {
    const r = roster([
      { wxId: "wxid_full", displayName: "jmr@nothing" },
      { wxId: "wxid_short", displayName: "jmr" },
    ]);
    const [m] = resolveMentions(`@jmr@nothing${SEP}hi`, r);
    assert.equal(m.wxId, "wxid_full");
  });

  it("**手打的 @ 不走这条规则** —— 边界本来就靠猜，再叠一层就是在编", () => {
    const r = roster([{ wxId: "wxid_jmr", displayName: "jmr" }]);
    // 没有定界符：走的是名册反推那条路，而 `@jmr@nothing` 里
    // `jmr` 后面跟的是 @，不是干净收尾
    const [m] = resolveMentions("@jmr@nothing 你要找的那个", r);
    assert.notEqual(m?.status, "resolved");
  });

  it("对不上就还是 unknown，字面昵称留作证据", () => {
    const r = roster([{ wxId: "wxid_x", displayName: "完全无关" }]);
    const [m] = resolveMentions(`@某某@某公司${SEP}hi`, r);
    assert.equal(m.status, "unknown");
    assert.equal(m.name, "某某@某公司");
  });
});
