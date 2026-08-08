import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.NEKOBOT_API_KEY = "nk_test";

// 与生产代码用同一份实现，不在测试里照抄一遍逻辑
import { truncateAtBoundary } from "@/lib/text";

/**
 * 站点地址配置测试。
 *
 * 分享卡片的绝对地址依赖 SITE_URL。这个值配错了本地完全看不出来，
 * 但线上分享出去的每一条链接预览图都是坏的。
 */
describe("站点地址", () => {
  it("SITE_URL 必须是合法的绝对地址", async () => {
    const { env } = await import("@/lib/env");
    assert.doesNotThrow(() => new URL(env.site.url), `SITE_URL 不是合法地址：${env.site.url}`);
  });

  it("生产环境不能是 localhost", async () => {
    const { env } = await import("@/lib/env");
    if (!env.isProd) return;
    assert.ok(
      !env.site.url.includes("localhost"),
      "线上 SITE_URL 指向 localhost，分享卡片会全部失效",
    );
  });

  it("WebAuthn 的 rpId 必须与站点域名一致", async () => {
    const { env } = await import("@/lib/env");
    const host = new URL(env.site.url).hostname;
    // rpId 与访问域名不一致时浏览器直接拒绝，且报错信息很难懂
    assert.equal(
      env.webauthn.rpId,
      host,
      `rpId(${env.webauthn.rpId}) 与站点域名(${host}) 不一致，Passkey 会全部失效`,
    );
  });

  it("WebAuthn 的 origin 必须与站点地址一致", async () => {
    const { env } = await import("@/lib/env");
    assert.equal(env.webauthn.origin.replace(/\/$/, ""), env.site.url.replace(/\/$/, ""));
  });
});

describe("分享卡片摘要截断", () => {
  it("短文本原样返回，不加省略号", () => {
    assert.equal(truncateAtBoundary("很短的一句话", 40), "很短的一句话");
  });

  it("断点足够靠后时在标点处断开", () => {
    const out = truncateAtBoundary("这是一段比较长的开头文字。后面还有很多内容会被截断掉", 20);
    assert.ok(out.endsWith("…"), out);
    assert.ok(!out.includes("后面还有"), out);
  });

  it("断点太靠前时宁可硬切，不为了好看丢掉大半内容", () => {
    const out = truncateAtBoundary("短。这后面是很长很长的一段内容不该被丢掉", 18);
    assert.ok(out.length > 10, `硬切也该保住大半：${out}`);
  });

  it("收尾不留悬挂的斜杠或顿号", () => {
    // 「反应 /」这种收尾看起来像渲染出错了
    const out = truncateAtBoundary("论坛：发帖 / 回帖 / 反应 / 收藏 / 订阅 / 通知聚合 全都做完了", 22);
    assert.ok(!/[\s/·、，]…$/.test(out), out);
  });

  it("全是同一个字时也不会返回空", () => {
    const out = truncateAtBoundary("啊".repeat(100), 20);
    assert.ok(out.length > 5, out);
    assert.ok(out.endsWith("…"));
  });
});
