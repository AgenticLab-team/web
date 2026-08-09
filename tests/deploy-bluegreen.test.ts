import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * 蓝绿部署。
 *
 * ─────────────────────────────────────────
 * 站长说「502 时间特别长、还频繁」
 * ─────────────────────────────────────────
 *
 * 拆开是两段，而**长的那段不是重启**：
 *
 *   一、构建那一分多钟。在线上直接 `npm run build` 会把正在跑的
 *       那个进程脚下的 `.next` 换掉 —— 运行中的实例按老的 chunk 名
 *       去读文件，而那些文件已经不在了。
 *   二、`systemctl restart` 之后 Next 起来之前那几秒，
 *       nginx 拿到 connection refused。
 *
 * 蓝绿把两段一起消掉：建的永远是没在服务的那一边，
 * 建好起好自检通过之后才改 nginx upstream 并 reload。
 *
 * ─────────────────────────────────────────
 * 这个文件为什么值得存在
 * ─────────────────────────────────────────
 *
 * 部署脚本是**唯一一段没有人在本地跑第二遍的代码**：它只在真的要上线
 * 那一刻执行，而那一刻出错的代价就是站点躺着。所以这里逐条钉死那些
 * 「写错了不会立刻发现、但真出事时会要命」的地方 —— 顺序、排除项、
 * 失败时切回去、以及别把两边的产物删掉。
 */

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
// 正则会匹配到脚本里自己的注释（那些注释恰好在讲同一件事），先剥掉
const strip = (s: string) => s.replace(/^\s*#.*$/gm, "");

const deploy = strip(read("scripts/deploy.sh"));
const rollback = strip(read("scripts/rollback.sh"));
const install = strip(read("scripts/install-bluegreen.sh"));
const blue = read("ops/agenticlab-blue.service");
const green = read("ops/agenticlab-green.service");
const upstream = read("ops/nginx-upstream.conf");
const nextConfig = read("next.config.ts");

describe("**构建不许碰正在服务的那一份产物**", () => {
  it("构建时指定的是目标那一边的目录", () => {
    assert.match(deploy, /NEXT_DIST_DIR=\.next-\$TARGET npm run build/);
  });

  it("distDir 认这个环境变量，否则上面那行没有任何作用", () => {
    assert.match(nextConfig, /distDir:\s*process\.env\.NEXT_DIST_DIR/);
  });

  it("**本地不设它的时候还是 .next** —— 不能让开发跟着换目录", () => {
    assert.match(nextConfig, /process\.env\.NEXT_DIST_DIR\s*\|\|\s*"\.next"/);
  });

  it("两边的目录名不一样，否则「另一边」根本不成立", () => {
    assert.match(blue, /NEXT_DIST_DIR=\.next-blue/);
    assert.match(green, /NEXT_DIST_DIR=\.next-green/);
  });

  it("两边的端口不一样，否则第二个起不来", () => {
    assert.match(blue, /Environment=PORT=3000/);
    assert.match(green, /Environment=PORT=3001/);
  });

  it("**两个构建目录都要可写** —— 一边要负责建另一边的产物", () => {
    for (const [name, unit] of [
      ["blue", blue],
      ["green", green],
    ] as const) {
      assert.match(unit, /ReadWritePaths=.*\.next-blue.*\.next-green/, name);
    }
  });

  it("**ReadWritePaths 的路径要带「不存在就跳过」的减号**", () => {
    /*
     * 第一次装的时候 .next-green 还不存在，而 systemd 建挂载命名空间时
     * 遇到列出来却不存在的路径会直接判启动失败 —— 症状是一个
     * 和构建、和代码都无关的 226/NAMESPACE，几乎不可能第一时间想到这里。
     */
    for (const [name, unit] of [
      ["blue", blue],
      ["green", green],
    ] as const) {
      const line = unit.split("\n").find((l) => l.startsWith("ReadWritePaths="))!;
      for (const path of line.slice("ReadWritePaths=".length).trim().split(/\s+/)) {
        assert.equal(path.startsWith("-/"), true, `${name} 的 ${path} 没带减号`);
      }
    }
  });
});

describe("**rsync 不能把线上那份产物删掉**", () => {
  it("排除的是 .next* 而不是 .next", () => {
    /*
     * 只写 --exclude .next 的话，--delete 会把 .next-blue / .next-green
     * 一起删掉 —— 而其中一份正是此刻在服务的那个版本。
     * 这一条写错的后果是**部署到一半站点没了**，且不会有任何报错。
     */
    assert.match(deploy, /--exclude '\.next\*'/);
    assert.equal(/--exclude \.next(?![-*\w])/.test(deploy), false, "还留着只排除 .next 的写法");
  });

  it("数据目录和 .env.local 照旧排除", () => {
    assert.match(deploy, /--exclude data/);
    assert.match(deploy, /--exclude \.env\.local/);
  });
});

describe("**顺序：先自检，再切流量**", () => {
  const at = (needle: string) => {
    const i = deploy.indexOf(needle);
    assert.notEqual(i, -1, `脚本里找不到「${needle}」`);
    return i;
  };

  it("构建在启动之前", () => {
    assert.ok(at("NEXT_DIST_DIR=.next-$TARGET npm run build") < at("systemctl restart agenticlab-$TARGET"));
  });

  it("**新实例自己探活通过之后才改 nginx**", () => {
    /*
     * 反过来的话，切过去的一刻用户拿到的是 connection refused ——
     * 那就把蓝绿做成了一个更复杂的、同样会 502 的部署。
     */
    assert.ok(at("TARGET_PORT/ || echo 000") < at("nginx -t"));
  });

  it("自检直连端口，绕开 nginx —— 那时候 nginx 还指着老的那边", () => {
    assert.match(deploy, /curl .*127\.0\.0\.1:\$TARGET_PORT/);
  });

  it("**起不来就停掉它并退出，而且不碰 nginx**", () => {
    const tail = deploy.slice(at("if [ -z \"$ready\" ]"));
    assert.match(tail, /systemctl stop agenticlab-\$TARGET/);
    const beforeFail = tail.slice(0, tail.indexOf("fail "));
    assert.equal(beforeFail.includes("reload nginx"), false, "起不来的分支里居然还 reload 了 nginx");
  });

  it("旧实例是在切完流量之后才停的", () => {
    assert.ok(at("reload nginx") < at("systemctl stop agenticlab-$ACTIVE"));
  });

  it("停旧实例之前等一下 —— reload 之后老 worker 手上还有请求", () => {
    const between = deploy.slice(at("公网探活"), at("systemctl stop agenticlab-$ACTIVE"));
    assert.match(between, /sleep/);
  });
});

describe("**切过去发现不对要能切回来**", () => {
  it("公网探活不过就切回原来那一边", () => {
    const branch = deploy.slice(deploy.indexOf('if [ -z "$ok" ]'));
    assert.match(branch, /ACTIVE_PORT/);
    assert.match(branch, /reload nginx/);
    assert.match(branch, /切回/);
  });

  it("改 nginx 之前先 nginx -t —— 配置写坏了 reload 会把整个 nginx 带走", () => {
    for (const [name, script] of [
      ["deploy", deploy],
      ["rollback", rollback],
      ["install", install],
    ] as const) {
      const t = script.indexOf("nginx -t");
      const r = script.indexOf("reload nginx");
      assert.notEqual(t, -1, `${name} 里没有 nginx -t`);
      assert.ok(t < r, `${name} 里 nginx -t 在 reload 之后`);
    }
  });
});

describe("回滚", () => {
  it("**不重新构建** —— 上一版的产物还在，起回来就行", () => {
    assert.equal(rollback.includes("npm run build"), false, "回滚里居然要构建");
  });

  it("另一边没有产物就拒绝 —— 那会把站点切进一个 502", () => {
    assert.match(rollback, /\.next-\$TARGET.*echo yes/);
    assert.match(rollback, /没有上一版可以回/);
  });

  it("回滚也要先自检再切", () => {
    assert.ok(rollback.indexOf("127.0.0.1:$TARGET_PORT") < rollback.indexOf("nginx -t"));
  });

  it("**说清楚数据库不跟着回滚**", () => {
    // 不说的话，人会以为回滚回到了「上一版的一切」，包括库结构
    assert.match(read("scripts/rollback.sh"), /迁移\*\*不会\*\*跟着回滚|迁移.*不会.*回滚/);
  });
});

describe("还没启用蓝绿的时候不能把部署搞坏", () => {
  it("读不到 upstream 就退回老路径，照样能部署", () => {
    assert.match(deploy, /if \[ -z "\$ACTIVE_PORT" \]/);
    const fallback = deploy.slice(deploy.indexOf('if [ -z "$ACTIVE_PORT" ]'), deploy.indexOf("else"));
    assert.match(fallback, /systemctl restart agenticlab\b/);
  });

  it("而且要提醒一句，否则没人知道还有这一步没做", () => {
    assert.match(read("scripts/deploy.sh"), /install-bluegreen\.sh/);
  });
});

describe("原来那些检查一条都不能少", () => {
  for (const [what, re] of [
    ["类型检查", /npx tsc --noEmit/],
    ["lint", /npx eslint \./],
    ["本地测试", /npm test/],
    ["服务器测试", /npm test > \/tmp\/test\.log/],
    ["首屏体积预算", /JS_BUDGET/],
  ] as const) {
    it(`还在跑${what}`, () => assert.match(deploy, re));
  }

  it("**lint 只挡 error，且是 [1-9] 开头** —— 写成 [0-9]+ 每次都会误判", () => {
    assert.match(deploy, /\[1-9\]\[0-9\]\* error/);
  });

  it("构建失败绝不切流量", () => {
    const line = deploy.split("\n").find((l) => l.includes("构建失败"));
    assert.ok(line, "构建失败那句话没了");
  });
});

describe("安装脚本", () => {
  it("幂等：把写死的 proxy_pass 换成 upstream，重复跑不会换第二次", () => {
    assert.match(install, /proxy_pass http:\/\/agenticlab_app/);
  });

  it("**蓝起不来就把老单元放回去** —— 不能装到一半把站点撂在那", () => {
    assert.match(install, /systemctl enable --now agenticlab\.service/);
  });

  it("upstream 文件里带着「现在是哪一边」，否则要靠端口号猜", () => {
    assert.match(upstream, /# active=(blue|green)/);
  });
});
