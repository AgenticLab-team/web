import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { PERMISSION_LIST } from "@/lib/rbac/permissions";

/**
 * 每个权限点到底管不管用。
 *
 * ─────────────────────────────────────────
 * 70 个里有 18 个从来没被判定过
 * ─────────────────────────────────────────
 *
 * 后台的权限矩阵把 70 个勾一视同仁地摆出来，看起来每一个都管事 ——
 * 而其中 18 个从来没有被传进任何一次判定。给一个人勾上它，
 * 什么都不会发生；把它取消掉，那个人照样做得了那件事。
 *
 * **权限是拿来限制人的东西，一个不生效的限制会让人以为已经限制住了。**
 *
 * 这一条测试的作用不是让那 18 个立刻消失（有些功能确实还没做），
 * 而是**逼它们如实标着** —— 标了 `wired` 就必须真的在某处被判过。
 */

const root = new URL("..", import.meta.url).pathname;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(full);
  }
  return out;
}

/**
 * 一个权限点「被判定过」的所有形态。
 *
 * 直接写字面量只是其中一种 —— 还有挂在导航项上、
 * 存成常量再传进去、以及版块级的默认权限。
 * 只认第一种的话，这条测试会把一堆真的在用的权限点报成死的，
 * 然后所有人开始无视它。
 */
const PATTERNS = [
  /(?:can|requireAdmin|requireWritableAdmin|has|hasPermission|requirePermission)\(\s*(?:[a-zA-Z_$][\w$.]*\s*,\s*)?"([a-z0-9_.]+)"/g,
  /(?:PERMISSION|Permission)\s*[:=]\s*"([a-z0-9_.]+)"/g,
  /permission:\s*"([a-z0-9_.]+)"/g,
  /\?\?\s*"([a-z0-9_.]+)"\)\s*as\s*"/g,
];

function enforcedKeys(): Set<string> {
  const found = new Set<string>();
  for (const file of walk(join(root, "src"))) {
    if (file.endsWith("rbac/permissions.ts")) continue;
    const body = readFileSync(file, "utf8");
    for (const re of PATTERNS) {
      for (const m of body.matchAll(re)) found.add(m[1]);
    }
  }
  return found;
}

const enforced = enforcedKeys();

describe("**标着 wired 的必须真的被判过**", () => {
  for (const perm of PERMISSION_LIST) {
    if (perm.status === "planned") continue;
    it(`${perm.key}`, () => {
      assert.equal(
        enforced.has(perm.key),
        true,
        `「${perm.label}」在代码里从来没被判过 —— ` +
          `要么接上，要么标成 status: "planned"。` +
          `留着不标的话，后台勾上它什么都不会发生，而没有人看得出来`,
      );
    });
  }
});

describe("**标着 planned 的要么真没接，要么就该改回 wired**", () => {
  it("没有一个 planned 其实已经接上了", () => {
    /*
     * 反向也要盯：一个功能做完之后，很容易忘了把标记改回来。
     * 而一个明明生效、却标着「还没做」的权限点，
     * 会让人以为可以随便勾。
     */
    const stale = PERMISSION_LIST.filter((p) => p.status === "planned" && enforced.has(p.key)).map(
      (p) => p.key,
    );
    assert.deepEqual(stale, [], `这些已经接上了，标记该改成 wired：${stale.join(", ")}`);
  });
});

describe("planned 的要说清楚为什么", () => {
  for (const perm of PERMISSION_LIST.filter((p) => p.status === "planned")) {
    it(`${perm.key} 有说明或者显然是功能没做`, () => {
      /*
       * 两种 planned 的处理不一样，所以要分得开：
       *   · 功能还没做 —— 等着就行
       *   · 功能做了，但代码用的是另一个更粗的权限点在管 ——
       *     这种更值得警惕：它意味着**细粒度的授权做不到**
       */
      const notImplemented = [
        "user.delete",
        "user.merge",
        "user.export",
        "permission.override",
        "module.install",
        "module.config",
        "broadcast.email",
        "badge.manage",
      ];
      if (notImplemented.includes(perm.key)) return;
      assert.ok(
        (perm.description ?? "").length > 4,
        `${perm.key} 标了 planned 但没说今天由谁在管`,
      );
    });
  }
});

describe("**管理员打得开他有权限的每一页**", () => {
  /*
   * 这一条是上面那个病最贵的一次表现：
   *
   * `ADMIN` 角色被显式拒绝了 `system.settings`，而功能开关那一页
   * 要的正是 `system.settings` —— 于是**管理员根本打不开它**，
   * 而专门为这件事存在的 `system.flags` 他有、却没有一行代码读。
   *
   * 存储页是反过来的：它只要 `system.dashboard`（进后台的最低门槛），
   * 而 `system.storage` 闲着 —— 也就是任何进得了后台的人都看得到。
   */
  const page = (p: string) => readFileSync(join(root, "src/app/(app)/admin", p), "utf8");

  it("功能开关页要的是 system.flags", () => {
    assert.match(page("flags/page.tsx"), /requireAdmin\("system\.flags"\)/);
  });

  it("存储页要的是 system.storage，不是「能进后台」", () => {
    assert.match(page("storage/page.tsx"), /requireAdmin\("system\.storage"\)/);
  });

  it("两页的写操作也走各自的权限点", () => {
    const flags = readFileSync(join(root, "src/lib/flags/actions.ts"), "utf8");
    const storage = readFileSync(join(root, "src/lib/storage/actions.ts"), "utf8");
    assert.match(flags, /requireWritableAdmin\("system\.flags"\)/);
    assert.match(storage, /requireWritableAdmin\("system\.storage"\)/);
  });
});
