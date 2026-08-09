import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

/**
 * 加载骨架的走查。和 a11y 走查同一个理由：一次性改干净会衰减 ——
 * 下个月新加一个板块，没有 loading.tsx，点进去又是一片空白，
 * 而没有人会想起来查。所以把「每个板块必须有自己的骨架」写成可执行的。
 */

const ROOT = join(import.meta.dirname, "..");
const APP = join(ROOT, "src/app/(app)");

/** (app) 下每个有 page.tsx 的直属板块。动态路由没有 loading 时会整段没反馈 */
function topLevelSections(): string[] {
  return readdirSync(APP).filter((name) => {
    const dir = join(APP, name);
    return statSync(dir).isDirectory() && existsSync(join(dir, "page.tsx"));
  });
}

describe("loading.tsx 覆盖", () => {
  it("(app) 每个直属板块都有自己的 loading.tsx", () => {
    /*
     * 为什么盯着「直属板块」：全站页面都是动态渲染（force-dynamic），
     * 没有本级 loading 的板块只能落到 (app)/loading.tsx —— 那个骨架
     * 是按首页形状画的，别的页面用它，加载完成时整页会跳一下。
     * 深层子路由（如 forum/p/[id]/edit）允许沿用上层边界，形状足够近。
     */
    const sections = topLevelSections();
    assert.ok(sections.length >= 10, `扫描范围不对，只找到 ${sections.length} 个板块`);

    const missing = sections.filter((name) => !existsSync(join(APP, name, "loading.tsx")));
    assert.deepEqual(
      missing,
      [],
      `这些板块没有 loading.tsx，导航过去会拿首页形状的骨架垫底：${missing.join(", ")}`,
    );
  });

  it("loading.tsx 全是服务端组件，不带客户端包袱", () => {
    // 骨架是要被预取进客户端缓存的静态壳 —— 一旦挂上 "use client"，
    // 它就要参与 hydration，等于给「等待画面」本身加载入成本
    const files = walk(join(ROOT, "src/app")).filter((f) => f.endsWith("loading.tsx"));
    assert.ok(files.length >= 15, `扫描范围不对，只找到 ${files.length} 个 loading.tsx`);

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      assert.ok(!source.includes('"use client"'), `${file} 不该是客户端组件`);
    }
  });

  it("每个 loading.tsx 都能渲染出元素", async () => {
    for (const file of walk(join(ROOT, "src/app")).filter((f) => f.endsWith("loading.tsx"))) {
      const mod = await import(file);
      assert.equal(typeof mod.default, "function", `${file} 缺少默认导出`);
      const element = mod.default();
      assert.ok(element && typeof element === "object", `${file} 渲染不出元素`);
    }
  });
});

describe("骨架的 aria", () => {
  const source = readFileSync(join(ROOT, "src/components/ui/Skeleton.tsx"), "utf8");

  it("灰块本体对读屏隐藏", () => {
    // 读屏用户不需要逐个听到几十个装饰灰块 —— 加载状态由 role=status 统一念
    assert.match(source, /aria-hidden/);
  });

  it("每个 status 容器都带 aria-busy", () => {
    /*
     * role="status" 让读屏念出「加载中」，aria-busy 则告诉辅助技术
     * 这块内容还没到位、先别急着重新遍历 —— 两个缺一个都只算做了一半。
     */
    const statusTags = source.match(/<[^>]*role="status"[^>]*>/g) ?? [];
    assert.ok(statusTags.length >= 2, "扫描范围不对，没找到 status 容器");
    for (const tag of statusTags) {
      assert.match(tag, /aria-busy="true"/, `缺 aria-busy：${tag}`);
    }
  });
});

describe("检索页的流式边界", () => {
  const source = readFileSync(join(APP, "search/page.tsx"), "utf8");

  it("语义检索只在 Suspense 子组件里 await", () => {
    /*
     * 嵌入接口的超时上限是 20 秒。这个 await 一旦回到页面函数顶层，
     * 嵌入服务一抖，整个检索页（连搜索框带筛选）就会跟着卡住 ——
     * 这正是拆出 SemanticResults 时要治的病，别让它悄悄长回来。
     */
    const awaitAt = source.indexOf("await semanticSearch");
    const childAt = source.indexOf("async function SemanticResults");
    assert.ok(awaitAt > -1 && childAt > -1, "语义检索的拆分结构不在了");
    assert.ok(awaitAt > childAt, "await semanticSearch 跑回页面顶层了");
    assert.match(source, /<Suspense key={query}/, "Suspense 要按 query 重新挂起，否则换词会拿旧结果充数");
  });
});

describe("后台导航的预取策略", () => {
  it("24 个入口只在出现意图时预取", () => {
    // 视口预取会让每次进后台都往 2 核的服务器上砸 24 次动态渲染
    const source = readFileSync(join(ROOT, "src/components/admin/AdminNav.tsx"), "utf8");
    assert.match(source, /prefetch={intent \? null : false}/);
    assert.match(source, /onFocus/, "键盘用户的聚焦也算意图，不能只认鼠标悬停");
  });
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}
