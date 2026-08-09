import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  contextFor,
  displayTitle,
  domainLabel,
  extractUrls,
  isPrivateHost,
  normalizeUrl,
} from "@/lib/links/extract";

/**
 * 链接抽取。
 *
 * 下面这几条**取自生产库里的真实消息** —— 抽错了不会报错，
 * 只会在资源库里躺着一个看起来完全正常、点进去 404 的地址。
 */

describe("从中文里把链接摘干净", () => {
  it("**URL 后面紧跟中文时要在中文处停下**（真实数据）", () => {
    const real = "https://cloud.siliconflow.cn/i/Ex4mpl3Ab现在硅基流动注册认证给16块钱";
    assert.deepEqual(extractUrls(real), ["https://cloud.siliconflow.cn/i/Ex4mpl3Ab"]);
  });

  it("有空格的正常情况（真实数据）", () => {
    const real = "https://typhoon.nmc.cn/web.html 可以使用此网站查询实时的台风情报";
    assert.deepEqual(extractUrls(real), ["https://typhoon.nmc.cn/web.html"]);
  });

  it("链接夹在一段话中间（真实数据）", () => {
    const real =
      "安装： npm install -g imnotcnuser 仓库： https://github.com/lopleec/imnotcnuser 任何使用问题欢迎提issue";
    assert.deepEqual(extractUrls(real), ["https://github.com/lopleec/imnotcnuser"]);
  });

  it("一条消息里多个链接都要抓到", () => {
    const urls = extractUrls("先看 https://a.com/x 再看 https://b.com/y");
    assert.deepEqual(urls, ["https://a.com/x", "https://b.com/y"]);
  });

  it("同一条里重复的只算一次", () => {
    assert.deepEqual(extractUrls("https://a.com/x 和 https://a.com/x"), ["https://a.com/x"]);
  });

  it("句尾标点不属于地址", () => {
    assert.deepEqual(extractUrls("见 https://a.com/b。"), ["https://a.com/b"]);
    assert.deepEqual(extractUrls("见 https://a.com/b."), ["https://a.com/b"]);
    assert.deepEqual(extractUrls("见 https://a.com/b，然后"), ["https://a.com/b"]);
    assert.deepEqual(extractUrls("(https://a.com/b)"), ["https://a.com/b"]);
    assert.deepEqual(extractUrls("「https://a.com/b」"), ["https://a.com/b"]);
  });

  it("**地址里本来就有的括号不能砍掉**", () => {
    assert.deepEqual(extractUrls("https://en.wikipedia.org/wiki/Foo_(bar)"), [
      "https://en.wikipedia.org/wiki/Foo_(bar)",
    ]);
  });

  it("带 query 和 fragment 的完整保留", () => {
    assert.deepEqual(extractUrls("https://a.com/s?q=1&p=2#top"), ["https://a.com/s?q=1&p=2#top"]);
  });

  it("http 和大写协议都认", () => {
    assert.equal(extractUrls("HTTP://a.com/x").length, 1);
    assert.equal(extractUrls("http://a.com/x").length, 1);
  });

  it("没有主机的不算链接", () => {
    assert.deepEqual(extractUrls("https://"), []);
    assert.deepEqual(extractUrls("https://foo"), []);
  });

  it("没有链接时返回空数组，不是 null", () => {
    assert.deepEqual(extractUrls("今天天气不错"), []);
    assert.deepEqual(extractUrls(""), []);
  });

  it("全角字符处停下 —— 输入法带出来的标点很常见", () => {
    assert.deepEqual(extractUrls("https://a.com/b（备用）"), ["https://a.com/b"]);
  });
});

describe("归一化 —— 同一个东西出现五次是资源库最没用的样子", () => {
  it("追踪参数去掉", () => {
    const a = normalizeUrl("https://a.com/p?utm_source=wx&utm_medium=share&id=7");
    const b = normalizeUrl("https://a.com/p?id=7");
    assert.equal(a?.key, b?.key);
    assert.equal(a?.url, "https://a.com/p?id=7", "展示地址里也不该留追踪参数");
  });

  it("常见的几种分享参数都认得", () => {
    for (const param of ["spm=abc", "fbclid=x", "from=groupmessage", "share_token=1", "si=xyz"]) {
      const stripped = normalizeUrl(`https://a.com/p?${param}`);
      assert.equal(stripped?.key, "a.com/p", `${param} 没被去掉`);
    }
  });

  it("query 顺序不同不算两个链接", () => {
    assert.equal(
      normalizeUrl("https://a.com/p?b=2&a=1")?.key,
      normalizeUrl("https://a.com/p?a=1&b=2")?.key,
    );
  });

  it("fragment 不进去重键也不进展示地址", () => {
    assert.equal(normalizeUrl("https://a.com/p#section")?.key, "a.com/p");
    assert.equal(normalizeUrl("https://a.com/p#section")?.url, "https://a.com/p");
  });

  it("www.、末尾斜杠、大小写、协议差异都不算两个链接", () => {
    const keys = [
      "https://www.a.com/p/",
      "https://a.com/p",
      "http://A.com/p",
      "https://WWW.A.COM/p/",
    ].map((u) => normalizeUrl(u)?.key);
    assert.equal(new Set(keys).size, 1, `分裂成了 ${new Set(keys).size} 个：${keys.join(" | ")}`);
  });

  it("**展示地址保留原本的主机名** —— 点开的时候 www 是有意义的", () => {
    assert.equal(normalizeUrl("https://www.a.com/p")?.url, "https://www.a.com/p");
  });

  it("不同路径仍然是不同链接", () => {
    assert.notEqual(normalizeUrl("https://a.com/p")?.key, normalizeUrl("https://a.com/q")?.key);
  });

  it("域名取的是去掉 www 的主机", () => {
    assert.equal(normalizeUrl("https://www.github.com/a/b")?.domain, "github.com");
  });
});

describe("不该收进来的地址", () => {
  it("**内网地址不收** —— 列在公开页面上等于免费做一次内网测绘", () => {
    for (const host of [
      "localhost",
      "127.0.0.1",
      "10.0.0.5",
      "192.168.1.1",
      "172.16.0.1",
      "172.31.255.1",
      "169.254.169.254",
      "box.local",
      "svc.internal",
    ]) {
      assert.equal(isPrivateHost(host), true, `${host} 被当成了公网地址`);
      assert.equal(normalizeUrl(`http://${host}/x`), null, `${host} 进了资源库`);
    }
  });

  it("公网地址不会被误判成内网", () => {
    for (const host of ["a.com", "172.32.0.1", "11.0.0.1", "192.169.0.1", "1.2.3.4"]) {
      assert.equal(isPrivateHost(host), false, `${host} 被误判成内网`);
    }
  });

  it("非 http 协议不收", () => {
    assert.equal(normalizeUrl("ftp://a.com/x"), null);
    assert.equal(normalizeUrl("javascript:alert(1)"), null);
    assert.equal(normalizeUrl("data:text/html,x"), null);
  });

  it("本站链接不收 —— 资源库里塞满自己的页面没有意义", () => {
    assert.equal(normalizeUrl("https://agenticlab.sh/forum/p/1", ["agenticlab.sh"]), null);
    assert.equal(normalizeUrl("https://www.agenticlab.sh/x", ["agenticlab.sh"]), null);
    assert.ok(normalizeUrl("https://agenticlab.com/x", ["agenticlab.sh"]));
  });

  it("解析不了的返回 null 而不是抛", () => {
    assert.equal(normalizeUrl("not a url"), null);
    assert.equal(normalizeUrl(""), null);
  });
});

describe("说明文字取自消息本身", () => {
  it("**取链接后面的话** —— 发链接的人往往已经写了一句更有用的", () => {
    const content = "https://typhoon.nmc.cn/web.html 可以使用此网站查询实时的台风情报";
    assert.equal(contextFor(content, "https://typhoon.nmc.cn/web.html"), "可以使用此网站查询实时的台风情报");
  });

  it("后面没话就取前面的", () => {
    const content = "推荐一个查台风的网站 https://typhoon.nmc.cn/web.html";
    assert.equal(contextFor(content, "https://typhoon.nmc.cn/web.html"), "推荐一个查台风的网站");
  });

  it("同一条里的其它链接不混进说明", () => {
    const content = "https://a.com/x 配合 https://b.com/y 一起用";
    const note = contextFor(content, "https://a.com/x");
    assert.equal(note?.includes("http"), false, "说明里混进了另一个链接");
    assert.match(note ?? "", /配合/);
  });

  it("**没有说明就留空，不编一个** ", () => {
    assert.equal(contextFor("https://a.com/x", "https://a.com/x"), null);
    assert.equal(contextFor("https://a.com/x 。", "https://a.com/x"), null);
  });

  it("太长的截断并加省略号", () => {
    const long = `https://a.com/x ${"很有用".repeat(50)}`;
    const note = contextFor(long, "https://a.com/x", 20);
    assert.equal(note?.length, 21);
    assert.ok(note?.endsWith("…"));
  });
});

describe("列表上显示什么", () => {
  it("**GitHub 显示仓库名** —— 一屏全是 github.com 没法看", () => {
    assert.equal(displayTitle("https://github.com/lopleec/imnotcnuser", "github.com"), "lopleec/imnotcnuser");
  });

  it("arXiv 显示编号", () => {
    assert.equal(displayTitle("https://arxiv.org/abs/2401.12345", "arxiv.org"), "arXiv 2401.12345");
  });

  it("首页显示可读的站名", () => {
    assert.equal(displayTitle("https://github.com/", "github.com"), "GitHub");
    assert.equal(displayTitle("https://zhihu.com/", "zhihu.com"), "知乎");
  });

  it("认不出来的域名就显示域名本身，不硬编一个名字", () => {
    assert.equal(domainLabel("box.muran.tech"), "box.muran.tech");
    assert.equal(displayTitle("https://box.muran.tech/", "box.muran.tech"), "box.muran.tech");
  });

  it("末段路径当标题，且会解码", () => {
    assert.equal(displayTitle("https://a.com/docs/%E6%8C%87%E5%8D%97", "a.com"), "指南");
  });

  it("末段太短时退回站名 —— 「a」当标题没有信息量", () => {
    assert.equal(displayTitle("https://zhihu.com/p", "zhihu.com"), "知乎");
  });
});

describe("标题里的文件名和通用段", () => {
  it("**扩展名要脱掉**（真实数据：typhoon.nmc.cn/web.html）", () => {
    assert.equal(displayTitle("https://typhoon.nmc.cn/web.html", "typhoon.nmc.cn"), "typhoon.nmc.cn");
  });

  it("有意义的末段脱掉扩展名之后保留", () => {
    assert.equal(displayTitle("https://a.com/getting-started.html", "a.com"), "getting-started");
    assert.equal(displayTitle("https://a.com/tutorial.php", "a.com"), "tutorial");
  });

  it("通用末段退回站名 —— 显示「index」等于没说", () => {
    for (const segment of ["index", "home", "main", "default", "detail", "zh-cn"]) {
      assert.equal(
        displayTitle(`https://zhihu.com/${segment}`, "zhihu.com"),
        "知乎",
        `${segment} 被当成了标题`,
      );
    }
  });

  it("不影响 GitHub 仓库名", () => {
    assert.equal(displayTitle("https://github.com/a/index", "github.com"), "a/index");
  });
});
