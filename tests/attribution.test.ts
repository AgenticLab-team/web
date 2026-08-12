import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseAttribution } from "@/lib/api-tokens/attribution";
import { SITE_HOST, withAttribution } from "@/lib/api-tokens/rules";

/**
 * 代发署名的解析。
 *
 * ═════════════════════════════════════════
 * 拼和解是**一对**
 * ═════════════════════════════════════════
 *
 * `withAttribution` 拼，`parseAttribution` 解。两边对不上的时候
 * 不会有任何报错 —— 只是从某一天起，新发的消息不再被认出来，
 * 而旧的还认得出，于是统计里悄悄混进一批算错的数据。
 *
 * 所以下面这些**拿 withAttribution 的真实产出去喂 parseAttribution**，
 * 而不是各自比对一个写死的字符串。写死的话，改了拼那一头，
 * 这份测试照样绿。
 */

describe("拼完能原样解回来", () => {
  for (const name of [
    "张三",
    "Alice",
    "带 空格 的",
    "emoji🧠昵称",
    // 昵称里带书名号 —— 正则要一直吃到最后一个「」」，不能用 [^」]*
    "「引号」怪人",
    "带|竖线(括号)的",
    "a".repeat(60),
  ]) {
    it(`「${name}」`, () => {
      const body = "大家好\n第二行";
      const parsed = parseAttribution(withAttribution(body, name));
      assert.ok(parsed, "拼出来的自己解不回来");
      assert.equal(parsed.body, body);
      assert.equal(parsed.senderName, name);
    });
  }

  it("名字为空时拼的是「某位成员」，解出来也是它", () => {
    const parsed = parseAttribution(withAttribution("喂", "   "));
    assert.equal(parsed?.senderName, "某位成员");
  });
});

describe("不该认错的", () => {
  it("普通消息返回 null —— 绝大多数消息都不是代发的", () => {
    assert.equal(parseAttribution("今天天气不错"), null);
  });

  it("**正文里引用了别人的代发消息，不算代发**", () => {
    /*
     * 署名永远是最后一行，所以正则锚在结尾。
     * 不锚的话，一条转述别人代发内容的消息会被误判 ——
     * 而它的作者是真人，误判会把他的发言算到代发头上。
     */
    const quoted = `他刚才说\n本消息由「张三」使用 ${SITE_HOST} 代发\n你看见了吗`;
    assert.equal(parseAttribution(quoted), null);
  });

  it("少了换行不算 —— 署名是**单独一行**", () => {
    assert.equal(parseAttribution(`喂本消息由「张三」使用 ${SITE_HOST} 代发`), null);
  });

  it("域名对不上不算", () => {
    assert.equal(parseAttribution("喂\n本消息由「张三」使用 evil.example 代发"), null);
  });

  it("正文本身是空的时候也解得出来", () => {
    const parsed = parseAttribution(withAttribution("", "张三"));
    assert.equal(parsed?.body, "");
    assert.equal(parsed?.senderName, "张三");
  });
});

describe("站内显示", () => {
  it("**MessageText 把署名拆成标记，不是当正文渲染**", async () => {
    /*
     * 原样渲染的话，那一行和正文同一个字号同一个颜色，
     * 看起来像发消息的人自己打的一句话 —— 而它是系统加的，
     * 并且它是唯一能说明「这话是谁让机器人说的」的东西。
     */
    const { readCode } = await import("./_source");
    const src = readCode("components/messages/MessageText.tsx");
    assert.match(src, /parseAttribution\(/);
    assert.match(src, /代发/);
  });
});
