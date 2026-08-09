import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { pageHref, pageWindow, paginate } from "@/lib/pagination";

/**
 * 分页的纯逻辑。
 *
 * 页码来自 URL，是敌对输入：?page=abc、?page=-1、?page=999
 * 都必须落到一个有内容的页上 —— 一个显示空白的第 999 页
 * 和「数据全没了」在管理员眼里是同一件事。
 */

describe("paginate：常规切片", () => {
  it("第一页：offset 0，perPage 条", () => {
    const s = paginate("1", 120, 50);
    assert.equal(s.page, 1);
    assert.equal(s.offset, 0);
    assert.equal(s.perPage, 50);
    assert.equal(s.totalPages, 3);
    assert.equal(s.hasPrev, false);
    assert.equal(s.hasNext, true);
  });

  it("中间页：offset = (page-1) * perPage", () => {
    const s = paginate("2", 120, 50);
    assert.equal(s.offset, 50);
    assert.equal(s.hasPrev, true);
    assert.equal(s.hasNext, true);
  });

  it("最后一页：hasNext 为 false", () => {
    const s = paginate("3", 120, 50);
    assert.equal(s.page, 3);
    assert.equal(s.offset, 100);
    assert.equal(s.hasNext, false);
  });

  it("不传 page 就是第一页 —— 大多数访问根本不带参数", () => {
    const s = paginate(undefined, 1803, 50);
    assert.equal(s.page, 1);
    assert.equal(s.totalPages, 37);
  });

  it("刚好整除：total=100 per=50 是两页，不多出一个空的第三页", () => {
    assert.equal(paginate("1", 100, 50).totalPages, 2);
    // 空的「下一页」比截断更迷惑 —— 点进去什么都没有
    assert.equal(paginate("2", 100, 50).hasNext, false);
  });

  it("总数不是 perPage 的倍数：余数单独成页", () => {
    assert.equal(paginate("1", 101, 50).totalPages, 3);
  });
});

describe("paginate：敌对输入兜底", () => {
  it("越过最后一页 → 夹到最后一页，不是空白页", () => {
    /*
     * ?page=999 多半是数据变少之后的旧链接 ——
     * 落到最后一页比回第一页更接近这个人原本想看的东西。
     */
    const s = paginate("999", 120, 50);
    assert.equal(s.page, 3);
    assert.equal(s.offset, 100);
  });

  it("解析不出来的一律回第一页", () => {
    for (const bad of ["abc", "", " ", "1.7", "2e3", "-", null, {}, true]) {
      assert.equal(paginate(bad, 120, 50).page, 1, `「${String(bad)}」没有回第一页`);
    }
  });

  it("负数和 0 回第一页", () => {
    assert.equal(paginate("-1", 120, 50).page, 1);
    assert.equal(paginate("0", 120, 50).page, 1);
    assert.equal(paginate("-999", 120, 50).page, 1);
  });

  it("空列表：第 1 页 / 共 1 页，offset 0 —— 页码必须有落脚点", () => {
    const s = paginate("5", 0, 50);
    assert.equal(s.page, 1);
    assert.equal(s.totalPages, 1);
    assert.equal(s.offset, 0);
    assert.equal(s.hasPrev, false);
    assert.equal(s.hasNext, false);
  });

  it("同名参数出现两次会是数组 —— 取第一个而不是抛错", () => {
    assert.equal(paginate(["2", "9"], 120, 50).page, 2);
    assert.equal(paginate([], 120, 50).page, 1);
  });

  it("perPage 为 0 或负数时不产生 Infinity 页", () => {
    // 页面代码里 perPage 是常量，但防御住 —— 除以 0 的结果会渲染成 NaN 页
    const s = paginate("1", 100, 0);
    assert.ok(Number.isFinite(s.totalPages));
    assert.ok(s.perPage >= 1);
  });

  it("total 为负或 NaN 当成空列表", () => {
    assert.equal(paginate("1", -5, 50).totalPages, 1);
    assert.equal(paginate("1", Number.NaN, 50).totalPages, 1);
  });
});

describe("pageWindow：页码窗口", () => {
  it("页数少时全列出来，没有省略号", () => {
    assert.deepEqual(pageWindow(1, 1), [1]);
    assert.deepEqual(pageWindow(3, 7), [1, 2, 3, 4, 5, 6, 7]);
  });

  it("页数多时始终包含第一页、最后一页、当前页 ±1", () => {
    const window = pageWindow(17, 40);
    for (const must of [1, 16, 17, 18, 40]) {
      assert.ok(window.includes(must), `窗口里缺 ${must}：${window.join(",")}`);
    }
  });

  it("gap 只在真的跳过页码时出现 —— 「1 … 2」是假省略", () => {
    const window = pageWindow(2, 40);
    // 1 和 2 相邻，不该有 gap
    const gapIndex = window.indexOf("gap");
    const numbers = window.filter((x): x is number => typeof x === "number");
    assert.deepEqual(numbers.slice(0, 3), [1, 2, 3]);
    assert.ok(gapIndex > 2);
  });

  it("窗口不超过 7 个元素 —— 手机上挤成一团的页码比没有页码更糟", () => {
    for (const [page, total] of [
      [1, 100],
      [50, 100],
      [100, 100],
      [2, 8],
      [7, 8],
    ] as const) {
      assert.ok(pageWindow(page, total).length <= 7, `page=${page} total=${total} 超了`);
    }
  });

  it("数字严格递增且不重复 —— 重复的页码链接点谁都说不清", () => {
    for (let page = 1; page <= 20; page++) {
      const numbers = pageWindow(page, 20).filter((x): x is number => typeof x === "number");
      for (let i = 1; i < numbers.length; i++) {
        assert.ok(numbers[i] > numbers[i - 1], `page=${page}：${numbers.join(",")}`);
      }
    }
  });

  it("当前页越界时窗口不崩", () => {
    // paginate 已经夹过页码，但 pageWindow 单独被调用时也不能炸
    assert.ok(pageWindow(999, 10).includes(10));
    assert.ok(pageWindow(0, 10).includes(1));
  });
});

describe("pageHref：链接生成", () => {
  it("第一页不带 page 参数 —— 同一页只能有一个 URL", () => {
    assert.equal(pageHref("/admin/users", {}, 1), "/admin/users");
    assert.equal(pageHref("/admin/users", { status: "banned" }, 1), "/admin/users?status=banned");
  });

  it("其余页带 page 且保留筛选参数", () => {
    assert.equal(
      pageHref("/admin/users", { q: "张", status: "active" }, 3),
      "/admin/users?q=%E5%BC%A0&status=active&page=3",
    );
  });

  it("值为空的参数不进 URL", () => {
    assert.equal(pageHref("/admin/audit", { action: undefined, days: "" }, 2), "/admin/audit?page=2");
  });

  it("调用方整包传入 searchParams 时，旧的 page 不跟着走", () => {
    // 不筛掉的话「第 3 页」的链接会带着 page=2 又被覆盖 —— 现在没事，改一行就出事
    assert.equal(pageHref("/admin/audit", { page: "7", days: "30" }, 2), "/admin/audit?days=30&page=2");
  });
});

describe("分页控件本身（源码层面）", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../src/components/ui/Pagination.tsx", import.meta.url)),
    "utf8",
  );

  it("是服务端组件 —— 首屏 JS 有预算，翻页只是导航，不值得客户端代码", () => {
    assert.ok(!source.includes('"use client"'), "Pagination 不该是客户端组件");
  });

  it("带上了读屏需要的 aria：nav 有名字、当前页有 aria-current", () => {
    assert.ok(source.includes('aria-label="分页"'), "nav 缺 aria-label");
    assert.ok(source.includes('aria-current='), "当前页缺 aria-current");
    assert.ok(source.includes("aria-label={`第 ${item} 页`}"), "页码链接缺 aria-label");
  });

  it("gap 省略号对读屏隐藏 —— 「…」念出来是噪音", () => {
    assert.ok(/aria-hidden[^>]*>\s*…/.test(source.replace(/\n/g, " ")) || source.includes("aria-hidden"), "gap 缺 aria-hidden");
  });

  it("总数一定会显示 —— 只有上一页/下一页的分页，人没法判断自己在哪", () => {
    assert.ok(source.includes("共 {total.toLocaleString"), "缺总数显示");
  });
});
