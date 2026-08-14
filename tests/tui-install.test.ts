import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isSupportedPlatform, validateManifest } from "@/lib/tui/release-rules";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  looksLikeCli,
  renderInstallScript,
  wantsHtml,
  wantsInstallScript,
} from "@/lib/tui/install-rules";

import { readCode } from "./_source";

/**
 * `curl -Ls agenticlab.sh | bash` 那条路上的两件事：
 * 判「这次请求想要脚本还是网页」，以及发布清单的校验。
 *
 * ═════════════════════════════════════════
 * 判错的两个方向，代价完全不对称
 * ═════════════════════════════════════════
 *
 * 判宽了（把浏览器当成 curl）：有人打开首页看到一屏 shell 源码。
 * 难看，但无害，而且当场就看得见。
 *
 * 判窄了（把 curl 当成浏览器）：**一整页 HTML 进了 bash**。
 * 绝大多数行会报 command not found 然后继续往下跑 ——
 * 而 HTML 里恰好有一行能被 shell 执行的东西的话，它就执行了。
 */

describe("**要脚本还是要网页**", () => {
  const browser =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
  const wechat =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 MicroMessenger/8.0.42";

  it("curl 拿脚本", () => {
    assert.equal(wantsInstallScript({ userAgent: "curl/8.4.0", accept: "*/*" }), true);
  });

  it("wget 也拿脚本", () => {
    assert.equal(wantsInstallScript({ userAgent: "Wget/1.21.4", accept: "*/*" }), true);
  });

  it("**浏览器拿网页**", () => {
    assert.equal(
      wantsInstallScript({ userAgent: browser, accept: "text/html,application/xhtml+xml" }),
      false,
    );
  });

  it("**微信内置浏览器拿网页** —— 这个站相当一部分访问来自那里", () => {
    assert.equal(wantsInstallScript({ userAgent: wechat, accept: "text/html" }), false);
  });

  it("**两条都要满足** —— 一个带 text/html 的 curl 拿网页", () => {
    /*
     * `curl -H 'Accept: text/html'` 是有人在用浏览器的方式看这个地址，
     * 那时候给他一段 shell 没有意义。
     *
     * 更要紧的是反过来：只看 Accept 不看 UA 的话，
     * 任何一个不发 Accept 的抓取器都会拿到安装脚本。
     */
    assert.equal(wantsInstallScript({ userAgent: "curl/8.4.0", accept: "text/html" }), false);
  });

  it("**没有 UA 的不算命令行**", () => {
    /*
     * 很多扫描器和探活工具不带 UA，而它们的请求量远大于真人。
     * 判成命令行的话，安装脚本会被当成首页反复抓走 ——
     * 不危险，但它会把这条判定的日志淹掉，
     * 而那些日志是「有多少人在装」的唯一来源。
     */
    assert.equal(looksLikeCli(null), false);
    assert.equal(looksLikeCli(""), false);
  });

  it("认不出的 UA 一律当浏览器 —— 白名单，不是黑名单", () => {
    /*
     * 反过来写（排除 Mozilla/Chrome/Safari）会把每一个认不出的 UA
     * 都判成命令行 —— 而认不出的里面有微信的一部分版本、
     * 有各种小众浏览器、有搜索引擎爬虫。
     */
    assert.equal(looksLikeCli("SomeNewBrowser/1.0"), false);
  });

  it("Accept 判定不区分大小写", () => {
    assert.equal(wantsHtml("TEXT/HTML"), true);
    assert.equal(wantsHtml("*/*"), false);
  });
});

describe("**生成出来的那段 shell 真的能被 bash 解析**", () => {
  /*
   * ═════════════════════════════════════════
   * 这是这份测试里唯一真正会救人的一条
   * ═════════════════════════════════════════
   *
   * 那段脚本是**生成**的，而它会被一千多人管道进 bash。
   * 一个语法错误的后果不是「装不上」——是 bash 把它**能解析的
   * 那一部分跑完**，然后停在中间某个地方。
   *
   * 而这种错完全不会在开发时暴露：没有人会在改完模板之后
   * 真的去 `curl | bash` 一次。
   *
   * 所以这里拿一份假清单渲染它，然后交给真的 `bash -n`。
   */
  const fakeManifest = {
    version: "9.9.9",
    releasedAt: 0,
    assets: [
      {
        platform: "linux-amd64" as const,
        url: "https://example.com/ash_linux_amd64",
        sha256: "a".repeat(64),
        size: 1,
      },
      {
        platform: "darwin-arm64" as const,
        url: "https://example.com/ash_darwin_arm64",
        sha256: "b".repeat(64),
        size: 1,
      },
    ],
  };

  const check = (script: string, label: string) => {
    const file = join(tmpdir(), `ash-install-${randomUUID()}.sh`);
    writeFileSync(file, script, "utf8");
    try {
      /*
       * `bash -n` 只解析不执行 —— 它不会真的去下载或者装东西。
       * 用 `sh -n` 是不够的：脚本里有 `local`、`[[`、数组这些
       * bash 特有的东西，而 sh 会把它们判成错。
       */
      execFileSync("bash", ["-n", file], { stdio: "pipe" });
    } catch (err) {
      const detail = err instanceof Error && "stderr" in err ? String(err.stderr) : String(err);
      assert.fail(`${label} 过不了 bash -n：\n${detail}`);
    } finally {
      rmSync(file, { force: true });
    }
  };

  it("已发布的那一版", () => {
    check(renderInstallScript(fakeManifest, "https://agenticlab.sh"), "已发布的脚本");
  });

  it("**还没发布过的那一版也要能跑** —— 它是新站的第一印象", () => {
    check(renderInstallScript(null, "https://agenticlab.sh"), "未发布时的脚本");
  });

  it("下载地址和校验和真的进了脚本里", () => {
    const script = renderInstallScript(fakeManifest, "https://agenticlab.sh");
    for (const a of fakeManifest.assets) {
      assert.ok(script.includes(a.url), `${a.platform} 的地址没进去`);
      assert.ok(script.includes(a.sha256), `${a.platform} 的校验和没进去`);
    }
  });

  it("**没有对应平台的分支要报错，而不是往下走**", () => {
    /*
     * 漏了这一条的话，一个 FreeBSD 用户会拿到一个 `url` 为空的
     * curl 调用 —— 而 `curl -fsSL -o file ""` 的报错
     * 和「这个平台没有二进制」完全不像。
     */
    const script = renderInstallScript(fakeManifest, "https://agenticlab.sh");
    assert.match(script, /\*\) die "没有为 \$platform 预编译的二进制/);
  });
});

describe("安装脚本本身", () => {
  const src = readCode("lib/tui/install-rules.ts");

  it("**整段包在函数里，最后一行才调用**", () => {
    /*
     * `curl | bash` 是边下边执行的。下到一半连接断了，
     * bash 会把已经收到的那半段跑完 —— 而那半段可能刚好停在
     * 解压之后、校验之前。
     *
     * 包成函数之后，没下完就没有最后那一行调用，于是一行都不会跑。
     * 这是所有 curl|bash 脚本里唯一真正重要的一条约定。
     */
    assert.match(src, /main\(\) \{/);
    assert.match(src, /\nmain "\$@"\n/);
  });

  it("**校验和那一步不能没有**", () => {
    assert.match(src, /sha256|shasum/);
    assert.match(src, /校验和对不上/);
  });

  it("`set -euo pipefail` —— 中间一步失败不许接着往下跑", () => {
    assert.match(src, /set -euo pipefail/);
  });

  it("**两个名字都装**", () => {
    /*
     * `ash` 是每天敲的那个；`agenticlab.sh` 是别人在群里贴出来的那个 ——
     * 一个人看到安装命令之后，最可能敲的下一个命令就是它。
     */
    assert.match(src, /agenticlab\.sh/);
    assert.match(src, /ln -sf/);
  });

  it("**系统上已经有 ash 就不覆盖** —— 那多半是 Almquist shell", () => {
    assert.match(src, /command -v ash/);
    assert.match(src, /没有覆盖它/);
  });

  it("没发布过的时候给一段会解释的脚本，而不是 404", () => {
    /*
     * 404 在管道里的表现是「什么也没发生」—— 人会以为命令跑成功了，
     * 然后去敲 ash，再拿到一句 command not found。
     */
    assert.match(src, /还没有发布终端客户端/);
  });
});

describe("发布清单：错一个字段就是所有人更新失败", () => {
  const ok = {
    version: "1.2.3",
    releasedAt: 0,
    assets: [
      {
        platform: "linux-amd64",
        url: "https://example.com/ash",
        sha256: "a".repeat(64),
        size: 1,
      },
    ],
  };

  it("形状对的收下", () => {
    assert.equal(validateManifest(ok).ok, true);
  });

  it("**没有 sha256 就不算数**", () => {
    /*
     * 自更新做的事是「拿一个文件当可执行程序跑」。
     * 校验做成可选的话，忘了填的那次发布会**静默地关掉校验**。
     */
    const bad = { ...ok, assets: [{ ...ok.assets[0], sha256: undefined }] };
    assert.equal(validateManifest(bad).ok, false);
  });

  it("sha256 格式不对也不算数", () => {
    const bad = { ...ok, assets: [{ ...ok.assets[0], sha256: "太短了" }] };
    assert.equal(validateManifest(bad).ok, false);
  });

  it("**下载地址必须是 https**", () => {
    /*
     * http 配合「下完就替换自己」是一条明文的远程执行 ——
     * 而它在开发机上跑得好好的，因为开发机的网络是可信的。
     */
    const bad = { ...ok, assets: [{ ...ok.assets[0], url: "http://example.com/ash" }] };
    assert.equal(validateManifest(bad).ok, false);
  });

  it("认不出的平台不算数 —— 免得有人下载一个 404 页面然后 chmod +x", () => {
    const bad = { ...ok, assets: [{ ...ok.assets[0], platform: "plan9-386" }] };
    assert.equal(validateManifest(bad).ok, false);
    assert.equal(isSupportedPlatform("plan9-386"), false);
    assert.equal(isSupportedPlatform("darwin-arm64"), true);
  });

  it("空的 assets 不算数", () => {
    assert.equal(validateManifest({ ...ok, assets: [] }).ok, false);
  });

  it("完全不是对象也不炸", () => {
    assert.equal(validateManifest(null).ok, false);
    assert.equal(validateManifest("nope").ok, false);
  });
});
