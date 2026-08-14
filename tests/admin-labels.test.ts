import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PERMISSIONS } from "@/lib/rbac/permissions";
import { DEFAULT_SETTINGS } from "@/lib/settings/defaults";

import { readCode } from "./_source";

/**
 * 后台那两排分组标签 —— **每一个分类都得有中文名**。
 *
 * ═════════════════════════════════════════
 * 它坏起来的样子是「看着像本来就这么设计的」
 * ═════════════════════════════════════════
 *
 * 两处 `categoryLabel()` 的兜底都是 `?? category`：认不出的分类
 * 不报错、不空白，它**显示原始 key**。于是权限矩阵那一排里
 * 混着一个英文小写的 `mail`，系统设置页上有四个英文标题。
 *
 * 那种降级不像 bug 到会有人去报 —— 一次截图普查才发现：
 * 78 项设置里有 28 项顶着英文标题（`mail` 13、`module` 9、
 * `digest` 4、`site` 2），而后三个比邮件功能早得多，
 * 也就是说**它一直是这样，从来没有人说过**。
 *
 * ─────────────────────────────────────────
 * 所以这条测试核的是「真源」，不是那张表自己
 * ─────────────────────────────────────────
 *
 * 断言「表里每一条都有值」是没有意义的（那是废话）。
 * 要核的方向是反的：**代码里真的存在的分类**，
 * 在表里必须找得到 —— 加一个新分类而忘了加标签，当场红。
 */

/** 从一个 `CATEGORY_LABELS` 字面量里抠出它认识的 key */
function labelledKeys(file: string): Set<string> {
  const code = readCode(file);
  const start = code.indexOf("const CATEGORY_LABELS");
  assert.notEqual(start, -1, `${file} 里找不到 CATEGORY_LABELS`);
  const body = code.slice(code.indexOf("{", start), code.indexOf("};", start));
  return new Set([...body.matchAll(/^\s*([a-z_]+)\s*:/gm)].map((m) => m[1]));
}

describe("**权限矩阵的每个分类都有中文名**", () => {
  it("PERMISSIONS 里出现过的 category，标签表里都有", () => {
    const known = labelledKeys("lib/admin/permissions.ts");
    const used = [...new Set(PERMISSIONS.map((p) => p.category))].sort();
    const missing = used.filter((c) => !known.has(c));
    assert.deepEqual(
      missing,
      [],
      `这些分类会在后台显示成英文小写：${missing.join("、")} —— ` +
        `在 lib/admin/permissions.ts 的 CATEGORY_LABELS 里补上`,
    );
  });

  it("**反过来也核** —— 表里不许留下已经没人用的分类", () => {
    /*
     * 一条没人用的标签不会有症状，但它会让人以为那个分类还在，
     * 于是下一个人照着它去找权限点，找不到，然后开始怀疑自己。
     * 这张表要么是真源的镜子，要么就什么都不是。
     */
    const known = labelledKeys("lib/admin/permissions.ts");
    const used = new Set<string>(PERMISSIONS.map((p) => p.category));
    const stale = [...known].filter((c) => !used.has(c)).sort();
    assert.deepEqual(stale, [], `这些分类已经没有任何权限点了：${stale.join("、")}`);
  });
});

describe("**系统设置的每个分类都有中文名**", () => {
  /*
   * 设置项的分类不是单独一列写死的，是 key 的第一段
   * （`mail.burner.per_day` → `mail`）。所以从默认值表里推。
   */
  const used = [...new Set(DEFAULT_SETTINGS.map((s) => s.key.split(".")[0]))].sort();

  it("默认值表里出现过的分类，标签表里都有", () => {
    const known = labelledKeys("lib/admin/settings.ts");
    const missing = used.filter((c) => !known.has(c));
    assert.deepEqual(
      missing,
      [],
      `这些分类会在系统设置页上显示成英文：${missing.join("、")} —— ` +
        `在 lib/admin/settings.ts 的 CATEGORY_LABELS 里补上`,
    );
  });

  it("这一页确实有分类要显示 —— 否则上面那条在断言空气", () => {
    assert.ok(used.length >= 8, `只推出 ${used.length} 个分类，取法八成坏了`);
  });
});

describe("**兜底还在，但它只兜到一个真正没见过的 key**", () => {
  it("两处都还有 `?? category`", () => {
    /*
     * 不建议把兜底改成抛错：后台设置页是**出事时要打开的那一页**，
     * 一个没登记的分类不该让整页 500。
     *
     * 兜底留着，测试在上面挡 —— 这两件事各管各的：
     * 测试保证「合进 main 的时候不会缺」，兜底保证
     * 「哪怕真缺了，也还是一页能打开的页面」。
     */
    for (const file of ["lib/admin/settings.ts", "lib/admin/permissions.ts"]) {
      assert.match(readCode(file), /CATEGORY_LABELS\[[a-zA-Z]+\]\s*\?\?\s*[a-zA-Z]+/, file);
    }
  });
});
