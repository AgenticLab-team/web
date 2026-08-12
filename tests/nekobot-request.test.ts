import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * 打上游那一层。
 *
 * ═════════════════════════════════════════
 * 这份测试是一条真实事故留下来的
 * ═════════════════════════════════════════
 *
 * `request()` 设了 `X-API-Key` 和 `Accept`，唯独没设 `Content-Type`。
 * 少这一行的时候 `fetch` 会自己填 `text/plain;charset=UTF-8`，
 * 而上游是 FastAPI —— 它按 Content-Type 决定怎么解析请求体，
 * 于是那串 JSON 被当成**一个字符串**交给 pydantic，每次 POST 都回 422：
 *
 *   {"type":"model_attributes_type",
 *    "msg":"Input should be a valid dictionary or object…",
 *    "input":"{\"conv_id\":\"…\",\"text\":\"…\"}"}
 *
 * 最难的地方是 `input` 里那串东西**看起来完全正确** —— 它就是我们要发的
 * 那个 JSON。读报错的人会一遍遍检查字段名，而问题在一个没写的头上。
 *
 * 影响的是所有 POST：发消息、撤回、通过好友申请、改群公告。
 * 站里从来没有成功发出去过一条，而它一直安静地记成
 * 「发送失败：上游返回 422」，看起来像上游的问题。
 *
 * ─────────────────────────────────────────
 * 所以这里跑的是**真的 request()**，不是一份抄写
 * ─────────────────────────────────────────
 *
 * 断言「源码里有 Content-Type 这个字符串」是抓不住的：
 * 它可能写在一个走不到的分支里、可能被后面的展开覆盖掉。
 * 这里换掉 `globalThis.fetch`，让真正那段代码跑一遍，
 * 然后看它**实际发出去的那个请求**长什么样。
 */

process.env.NEKOBOT_API_KEY = "nk_test";
process.env.NEKOBOT_BASE_URL = "http://upstream.test/v1";

let nekobot: typeof import("@/lib/nekobot/client").nekobot;
const realFetch = globalThis.fetch;

/** 每次调用实际发出去的请求 */
let calls: { url: string; init: RequestInit }[] = [];

before(async () => {
  ({ nekobot } = await import("@/lib/nekobot/client"));
});

after(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});

/** 大小写不敏感地取一个头 —— header 名字本来就不区分大小写 */
function headerOf(init: RequestInit, name: string): string | undefined {
  const headers = (init.headers ?? {}) as Record<string, string>;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

describe("带 body 的请求", () => {
  it("**发文本带 Content-Type: application/json**", async () => {
    await nekobot.sendText("room@chatroom", "喂");
    assert.equal(calls.length, 1);
    assert.equal(
      headerOf(calls[0].init, "content-type"),
      "application/json",
      "没有这个头，FastAPI 会把整串 JSON 当成一个字符串，回 422",
    );
  });

  it("body 确实是**对象序列化**，不是被包了两层的字符串", async () => {
    /*
     * 另一种能造成同样 422 的写法是 `JSON.stringify(JSON.stringify(x))`。
     * 报错一模一样，所以这里一并钉住：解出来必须是个对象。
     */
    await nekobot.sendText("room@chatroom", "喂");
    const parsed = JSON.parse(String(calls[0].init.body));
    assert.equal(typeof parsed, "object");
    assert.equal(parsed.conv_id, "room@chatroom");
    assert.equal(parsed.text, "喂");
  });

  it("**每一个带 body 的方法都带上了** —— 漏一个就等于那条路不通", async () => {
    /*
     * 逐个跑真的调用。写在 request() 里就是为了没有调用点需要记得，
     * 但「以后有人在某个方法上自己传 headers 覆盖掉它」是可能的 ——
     * 那种覆盖只会让那一条路挂掉，别的都好，最难发现。
     */
    const bodied: [string, () => Promise<unknown>][] = [
      ["sendText", () => nekobot.sendText("c", "t")],
      ["revoke", () => nekobot.revoke("c", "m")],
      ["setAnnouncement", () => nekobot.setAnnouncement("c", "t")],
    ];

    for (const [name, run] of bodied) {
      calls = [];
      await run();
      assert.ok(calls.length > 0, `${name} 没发出请求？`);
      for (const call of calls) {
        assert.ok(call.init.body, `${name} 应该带 body`);
        assert.equal(
          headerOf(call.init, "content-type"),
          "application/json",
          `${name} 少了 Content-Type —— 上游会回 422`,
        );
      }
    }
  });
});

describe("不带 body 的请求", () => {
  it("**没有正文的 POST 也不塞** —— 通过好友申请就是这种", async () => {
    /*
     * 规矩是「有正文就声明正文类型」，不是「POST 就声明」。
     * 上游那条 accept 不收正文，硬塞一个 Content-Type 说的是
     * 一件不存在的事 —— 而有些框架会因此去等一个永远不来的正文。
     */
    await nekobot.acceptFriendRequest("wx");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.body, undefined);
    assert.equal(headerOf(calls[0].init, "content-type"), undefined);
  });

  it("GET 不硬塞 Content-Type —— 没有正文的请求声明正文类型是无意义的", async () => {
    await nekobot.sendQuota();
    assert.equal(headerOf(calls[0].init, "content-type"), undefined);
  });

  it("鉴权头一直都在", async () => {
    await nekobot.sendQuota();
    assert.equal(headerOf(calls[0].init, "x-api-key"), "nk_test");
  });
});
