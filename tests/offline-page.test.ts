import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * 「这个网站遇到问题，正在重启中」那一页。
 *
 * ─────────────────────────────────────────
 * 装好了、内容也对，而没有一个用户见过它
 * ─────────────────────────────────────────
 *
 * 页面在源站上是对的：直接在服务器里打，拿到完整的 4660 字节。
 * 而**从公网打，拿到的是 16 字节的 `error code: 502`**
 * （`content-type: text/plain`、`server: cloudflare`）——
 * Cloudflare 把源站的 502 换成了它自己的页。
 *
 * 503 是原样透传的（实测：4660 字节、text/html、状态 503 到浏览器）。
 * 所以 nginx 现在把 502/504 一并改写成 503 再出去。
 *
 * 这个状态码本来也更准确：502 是「上游返回了不能理解的东西」，
 * 而这个站上这三个码只有一个含义 —— Node 进程这一刻不在，
 * 那是 503「暂时不可用」。
 */

const conf = readFileSync(new URL("../ops/nginx-error-pages.conf", import.meta.url), "utf8");
const page = readFileSync(new URL("../ops/502.html", import.meta.url), "utf8");

describe("**502 必须改写成 503 才出得去**", () => {
  it("error_page 带 =503", () => {
    assert.match(conf, /error_page 502 503 504 =503 \/__offline\.html;/);
  });

  it("**理由写在文件里** —— 不写的话下一个人只会觉得这个 `=503` 多余", () => {
    assert.match(conf, /Cloudflare/);
    assert.match(conf, /16 字节/);
  });

  it("带 Retry-After —— 告诉爬虫和监控这是暂时的", () => {
    assert.match(conf, /add_header Retry-After/);
  });

  it("**不缓存** —— 缓存住就永远显示「正在重启」了", () => {
    assert.match(conf, /Cache-Control "no-store"/);
  });

  it("**internal** —— 不给直接访问", () => {
    // 能直接访问的话，一个正常的站上摆着一页「正在重启」，很怪
    assert.match(conf, /^\s*internal;/m);
  });
});

describe("页面本身", () => {
  it("说的是人话，不是「502 Bad Gateway」", () => {
    assert.match(page, /遇到问题/);
    assert.match(page, /正在重启/);
  });

  it("**自己会重试** —— 让人一直手动刷新是最糟的等待", () => {
    assert.match(page, /setTimeout|location\.reload|setInterval/);
  });

  it("不引外部资源 —— 站都挂了，再去拉一个 CDN 只会更慢或者直接白屏", () => {
    assert.equal(/<script[^>]+src=/.test(page), false);
    assert.equal(/<link[^>]+href="https?:/.test(page), false);
  });

  it("**不塞进任何要登录才知道的信息**", () => {
    // 这一页是公开的，谁都可能看到
    for (const leak of ["agenticlab.sh/admin", "wxid_", "@chatroom"]) {
      assert.equal(page.includes(leak), false, `502 页里出现了 ${leak}`);
    }
  });
});
