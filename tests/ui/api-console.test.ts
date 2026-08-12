import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { ApiConsole } from "@/components/api/ApiConsole";
import { SendLog } from "@/components/api/SendLog";

/**
 * 在线测试与代发日志。
 *
 * ═════════════════════════════════════════
 * 在线测试必须走**真正那条路**
 * ═════════════════════════════════════════
 *
 * 做成「服务端替他调一次」会舒服很多（不用他粘令牌），
 * 但那就变成了另一条路：绕过 Authorization 头、绕过令牌校验 ——
 * 于是控制台能跑通、他的脚本跑不通，而他会以为是自己写错了。
 */

const render = async (component: unknown, props: unknown): Promise<string> => {
  const [{ renderToStaticMarkup }, { createElement }] = await Promise.all([
    import("react-dom/server"),
    import("react"),
  ]);
  return renderToStaticMarkup(createElement(component as never, props as never));
};

const ENDPOINTS = [
  { method: "GET" as const, path: "/api/v1/me", summary: "我是谁", scopes: ["me:read"] },
  {
    method: "POST" as const,
    path: "/api/v1/groups/{conv_id}/messages",
    summary: "发消息",
    scopes: ["groups:send"],
  },
];

describe("在线测试", () => {
  it("列出端点、要令牌", async () => {
    const html = await render(ApiConsole, { endpoints: ENDPOINTS });
    assert.match(html, /\/api\/v1\/me/);
    assert.match(html, /在线试一下/);
  });

  it("**令牌输入框是 password** —— 这一页很可能在别人旁边打开", async () => {
    const html = await render(ApiConsole, { endpoints: ENDPOINTS });
    assert.match(html, /type="password"/);
  });

  it("**不自动填充** —— 浏览器不该把令牌记进表单历史", async () => {
    assert.match(await render(ApiConsole, { endpoints: ENDPOINTS }), /autocomplete="off"/i);
  });

  it("**从浏览器直接打 /api/v1，不走服务端代调**", () => {
    /*
     * 走代调的话，控制台用的是另一套鉴权 ——
     * 能在这里跑通、在他机器上跑不通，而他会以为是自己写错了。
     */
    const src = readFileSync(
      new URL("../../src/components/api/ApiConsole.tsx", import.meta.url),
      "utf8",
    );
    assert.match(src, /await fetch\(url,/);
    assert.match(src, /Authorization: `Bearer \$\{token\.trim\(\)\}`/);
    assert.equal(src.includes('"use server"'), false, "变成服务端代调了");
  });

  it("**写操作要说清楚不是沙箱**", async () => {
    /*
     * 点下去，一千六百人的群里真的会多一条消息 ——
     * 说在前面，而不是让他从群友的反应里发现。
     */
    const src = readFileSync(
      new URL("../../src/components/api/ApiConsole.tsx", import.meta.url),
      "utf8",
    );
    assert.match(src, /这不是沙箱/);
    assert.match(src, /真的发出去/);
  });
});

describe("代发日志", () => {
  const row = {
    id: "s1",
    tokenId: "t1",
    tokenName: "打卡机器人",
    userId: "u1",
    convId: "g1@chatroom",
    convName: "车棚",
    text: "大家好\n本消息由「小明」使用 AgenticLab.sh 代发",
    ok: true,
    error: null,
    at: 1_770_000_000_000,
  };

  it("**正文原样摆出来** —— 只给条数等于什么都没说", async () => {
    const html = await render(SendLog, { rows: [row] });
    assert.match(html, /大家好/);
    // 署名那一行也要看得见 —— 这一页也是「署名有没有真加上」的检查手段
    assert.match(html, /本消息由「小明」使用 AgenticLab\.sh 代发/);
  });

  it("失败的要标出来", async () => {
    const html = await render(SendLog, {
      rows: [{ ...row, ok: false, error: "上游拒绝了这一条" }],
    });
    assert.match(html, /失败/);
    assert.match(html, /上游拒绝了这一条/);
  });

  it("**默认不显示是谁** —— 自己那一页上每一条都是自己的", async () => {
    const html = await render(SendLog, { rows: [row] });
    assert.equal(html.includes("u1"), false);
  });

  it("管理员视角才带上人", async () => {
    const html = await render(SendLog, { rows: [row], showWho: true });
    assert.match(html, /u1/);
  });

  it("空的时候说一句，不留白", async () => {
    assert.match(await render(SendLog, { rows: [] }), /还没有通过 API 代发过消息/);
  });

  it("**换行要保留** —— 署名是单独一行，糊在一起就看不出来了", async () => {
    assert.match(await render(SendLog, { rows: [row] }), /whitespace-pre-wrap/);
  });
});
