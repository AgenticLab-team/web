import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * 两条跑法都要真的被跑到。
 *
 * ═════════════════════════════════════════
 * 为什么会有第二条
 * ═════════════════════════════════════════
 *
 * 主测试跑在 `--conditions=react-server` 下。那个条件下
 * **`react-dom/server` 和 `lucide-react` 都 import 不进来** ——
 * 前者直接报「不支持」，后者拿不到 `createContext`。
 *
 * 这就是为什么这个仓库里所有和组件有关的测试一直只在读源码字符串：
 * 不是不想渲染，是那个跑法下渲染不了。而读字符串守得住
 * 「这一行别被删」，守不住**它到底渲染成了什么** ——
 * 条件写反、属性挂错元素、图标和文案对不上，
 * 源码里那几个字符串一个不少，页面上却是错的。
 *
 * ═════════════════════════════════════════
 * 而分出一条跑法，最大的风险是没人跑它
 * ═════════════════════════════════════════
 *
 * 一条没人跑的测试比没有测试更糟：它让人以为那一块有人守着。
 * 所以这里盯死三件事 —— `npm test` 两条都跑、`tests/ui/` 不是空的、
 * 而且 ui 那一条不带 react-server 条件（带了就等于没分）。
 */

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  scripts: Record<string, string>;
};

describe("**`npm test` 必须把两条都跑一遍**", () => {
  it("test 同时跑 server 和 ui", () => {
    /*
     * 这一条是整份文件的重点。改成只跑一条的话，
     * tests/ui 下面那些会安静地再也不执行 ——
     * 没有任何地方会红，而它们守的正是「页面渲染出来对不对」。
     */
    const test = pkg.scripts.test;
    assert.match(test, /test:server/, "npm test 不再跑主测试了");
    assert.match(test, /test:ui/, "npm test 不再跑 UI 渲染测试了");
  });

  it("主测试仍然带 react-server 条件", () => {
    // 服务端组件、server-only 模块都靠它才 import 得进来
    assert.match(pkg.scripts["test:server"], /--conditions=react-server/);
  });

  it("**UI 那一条不能带 react-server** —— 带了就 import 不进 react-dom", () => {
    assert.equal(
      pkg.scripts["test:ui"].includes("react-server"),
      false,
      "ui 那条也带上条件的话，分出来这一条就毫无意义了",
    );
  });

  it("两条覆盖的目录不重叠 —— 同一个文件跑两遍只会让人困惑", () => {
    assert.match(pkg.scripts["test:server"], /tests\/\*\.test\.ts/);
    assert.match(pkg.scripts["test:ui"], /tests\/ui\/\*\.test\.ts/);
  });
});

describe("两边都不许是空的", () => {
  const inDir = (d: string) =>
    readdirSync(new URL(`../tests/${d}`, import.meta.url).pathname).filter((f) =>
      f.endsWith(".test.ts"),
    );

  it("**tests/ui 里有东西** —— 空目录配一条跑法，是一份假的安全感", () => {
    assert.ok(inDir("ui").length > 0, "tests/ui 是空的");
  });

  it("主目录当然也有", () => {
    assert.ok(
      readdirSync(new URL("../tests", import.meta.url).pathname).filter((f) =>
        f.endsWith(".test.ts"),
      ).length > 50,
    );
  });
});

describe("**部署脚本跑的是 `npm test`**，不是某一条", () => {
  it("本地和服务器两处都是", () => {
    /*
     * 写成 `npm run test:server` 的话，UI 那一条就只在有人手动跑时
     * 才执行 —— 也就是几乎不执行。
     */
    const deploy = readFileSync(new URL("../scripts/deploy.sh", import.meta.url), "utf8")
      // 注释里会提到别的命令，先剥掉
      .replace(/^\s*#.*$/gm, "");
    assert.match(deploy, /npm test/);
    assert.equal(
      /npm run test:(server|ui)/.test(deploy),
      false,
      "部署只跑了其中一条",
    );
  });
});

/**
 * 认的是**真的 import 了**，不是「文中出现过这几个字」。
 *
 * 按出现次数判的话，这个文件自己第一个中招 —— 它必须写下
 * 那个包名才能做这项检查。上一次踩这个坑是一条断言把自己的
 * 解释性注释当成了违规代码。
 */
const IMPORTS_RENDERER = /(?:from|import\()\s*["']react-dom\/server["']/;

describe("tests/ui 里放的必须是渲染测试", () => {
  it("**每个文件都真的渲染了组件** —— 不然它没有理由待在这条跑法里", () => {
    /*
     * 放一个纯逻辑测试进来不会报错，但它会让人以为
     * 「UI 那条跑法覆盖得挺多」，而实际渲染过的可能一个都没有。
     */
    const dir = new URL("../tests/ui/", import.meta.url).pathname;
    const bad: string[] = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".test.ts"))) {
      const body = readFileSync(`${dir}${f}`, "utf8");
      if (!IMPORTS_RENDERER.test(body)) bad.push(f);
    }
    assert.deepEqual(bad, [], "这几个文件没有渲染任何东西，不该放在 tests/ui");
  });

  it("不在这个目录里的测试不许 import react-dom/server —— 那边跑不起来", () => {
    const dir = new URL("../tests/", import.meta.url).pathname;
    const bad: string[] = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".test.ts"))) {
      if (IMPORTS_RENDERER.test(readFileSync(`${dir}${f}`, "utf8"))) bad.push(f);
    }
    assert.deepEqual(bad, [], "这几个会在 react-server 条件下直接崩，要挪到 tests/ui");
  });
});

