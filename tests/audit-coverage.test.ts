import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  DELEGATES,
  READ_ONLY_ALLOWLIST,
  auditGaps,
  delegatesAudit,
  hasAudit,
  hasWrite,
  requiresAdmin,
  splitFunctions,
} from "@/lib/audit/coverage";

/**
 * 审计覆盖。
 *
 * ─────────────────────────────────────────
 * SCHEMA.md 自己写着「靠自觉一定会漏」
 * ─────────────────────────────────────────
 *
 * 而这套东西直到现在**就是靠自觉**：每个后台写操作都要记 audit()，
 * 但没有任何东西在检查。
 *
 * 运行时拦截层做不出来 —— drizzle 的写入没有统一入口，硬套一层代理
 * 只会得到一堆「谁在写」说不清楚的记录。而说不清楚是谁写的审计日志，
 * 比没有更糟：它会让人以为查过了。
 *
 * 所以做成静态检查：调了 requireAdmin 又做了写操作的函数，
 * 必须调 audit()，或者把记账委托给某个自己会记的模块。
 * 这抓不到「记了但记错了」，只抓「压根没记」—— 而后者占绝大多数。
 */

const ROOT = fileURLToPath(new URL("../", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") ? [path] : [];
  });
}

function adminFiles(): { path: string; source: string }[] {
  return walk(join(ROOT, "src/lib"))
    .map((path) => ({ path, source: readFileSync(path, "utf8") }))
    .filter((f) => f.source.includes("requireAdmin"));
}

describe("**每个后台写操作都要留痕**", () => {
  it("src/lib 下没有「调了 requireAdmin 又写库却不记账」的函数", () => {
    const gaps = adminFiles().flatMap((f) =>
      auditGaps(f.path.replace(ROOT, ""), f.source),
    );

    assert.deepEqual(
      gaps.map((g) => `${g.file}:${g.line} ${g.fn}()`),
      [],
      `\n${gaps.map((g) => `  ${g.file}:${g.line} ${g.fn}() —— ${g.reason}`).join("\n")}\n`,
    );
  });

  it("扫描范围没有缩水", () => {
    const files = adminFiles();
    assert.ok(files.length >= 15, `只扫到 ${files.length} 个后台文件，范围不对`);
  });
});

describe("检查器本身：该报的要报", () => {
  const write = `
    export async function doThing() {
      await requireAdmin("x.y");
      db.update(users).set({ a: 1 }).run();
      return { ok: true };
    }
  `;

  it("**写了不记就报**", () => {
    const gaps = auditGaps("f.ts", write);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].fn, "doThing");
  });

  it("记了就不报", () => {
    const good = write.replace("return { ok: true };", 'audit(ctx, { action: "x.y" });');
    assert.deepEqual(auditGaps("f.ts", good), []);
  });

  it("audited() 包住的也算", () => {
    const good = write.replace(
      "db.update(users).set({ a: 1 }).run();",
      "audited(ctx, entry, () => db.update(users).set({ a: 1 }).run());",
    );
    assert.deepEqual(auditGaps("f.ts", good), []);
  });

  it("insert / delete / 裸 SQL 都算写操作", () => {
    assert.equal(hasWrite("db.insert(users).values({}).run()"), true);
    assert.equal(hasWrite("db.delete(users).run()"), true);
    assert.equal(hasWrite('sqlite.prepare("DELETE FROM x WHERE id = ?")'), true);
    assert.equal(hasWrite('sqlite.prepare("UPDATE x SET a = 1")'), true);
  });

  it("**只读的不报** —— 报了会让人给它加一条没有意义的日志", () => {
    const readOnly = `
      export async function readThing() {
        await requireAdmin("x.y");
        return db.select().from(users).all();
      }
    `;
    assert.deepEqual(auditGaps("f.ts", readOnly), []);
  });

  it("不碰后台的函数不报 —— 用户自己的写操作不进审计日志", () => {
    const userAction = `
      export async function myOwnThing() {
        const user = await getCurrentUser();
        db.update(users).set({ a: 1 }).run();
      }
    `;
    assert.deepEqual(auditGaps("f.ts", userAction), []);
  });
});

describe("委托与豁免这两张表要能自证", () => {
  it("**被委托的函数自己真的会记账**", () => {
    /*
     * 这张表写错一个名字，就等于给某个函数发了永久豁免 ——
     * 而豁免是静默的：它不会报错，只是从此不再检查。
     */
    const sources = walk(join(ROOT, "src/lib")).map((p) => readFileSync(p, "utf8"));

    for (const name of DELEGATES) {
      const owner = sources.find((s) =>
        new RegExp(`export\\s+(async\\s+)?function\\s+${name}\\b`).test(s),
      );
      assert.ok(owner, `委托表里的 ${name} 根本不存在`);

      const fn = splitFunctions(owner).find((f) => f.name === name)!;
      assert.ok(
        hasAudit(fn.body) || delegatesAudit(fn.body) !== null,
        `${name} 被列为「会自己记账」，但它自己也没有 audit()`,
      );
    }
  });

  it("**豁免名单里的函数真的不写库**", () => {
    const sources = walk(join(ROOT, "src/lib")).map((p) => readFileSync(p, "utf8"));

    for (const name of READ_ONLY_ALLOWLIST) {
      const owner = sources.find((s) =>
        new RegExp(`export\\s+(async\\s+)?function\\s+${name}\\b`).test(s),
      );
      assert.ok(owner, `豁免名单里的 ${name} 根本不存在 —— 删掉它`);

      const fn = splitFunctions(owner).find((f) => f.name === name)!;
      if (!hasWrite(fn.body)) continue;

      /*
       * 允许一种例外：写的是「等待确认」的任务行本身。
       * 真正执行时会记账，在出预览那一步再记一条只会制造噪音。
       * 但这条例外必须写在这里，而不是躺在名单里说不清楚。
       */
      assert.equal(
        name,
        "createPruneTask",
        `${name} 在豁免名单里却做了写操作 —— 要么记账，要么从名单里拿掉`,
      );
    }
  });

  it("豁免名单不能越来越长 —— 每加一条都要有理由", () => {
    assert.ok(
      READ_ONLY_ALLOWLIST.size <= 6,
      `豁免名单已经有 ${READ_ONLY_ALLOWLIST.size} 条，该回头看看是不是在拿它绕过检查`,
    );
  });
});

describe("函数切分的正确性", () => {
  it("按括号配平找函数体，不靠缩进", () => {
    const source = `
      export function a() {
        if (x) { y(); }
        return 1;
      }
      export function b() { return 2; }
    `;
    const fns = splitFunctions(source);
    assert.deepEqual(fns.map((f) => f.name), ["a", "b"]);
    assert.match(fns[0].body, /y\(\)/);
    assert.equal(fns[1].body.includes("y()"), false, "两个函数被切到一起了");
  });

  it("字符串里的花括号不打乱计数", () => {
    const source = `export function a() { const s = "{{{"; return s; }`;
    assert.equal(splitFunctions(source).length, 1);
  });

  it("认得 async", () => {
    const fns = splitFunctions("export async function a() { return 1; }");
    assert.equal(fns[0].isAsync, true);
  });

  it("非导出的函数不参与判定 —— 它们由调用方负责", () => {
    assert.deepEqual(splitFunctions("function helper() { db.insert(x).run(); }"), []);
  });

  it("行号能定位", () => {
    const source = "const x = 1;\n\nexport function a() { return 1; }";
    assert.equal(splitFunctions(source)[0].line, 3);
  });

  it("**内联参数类型里的花括号不能被当成函数体开头**", () => {
    /*
     * 第一版就栽在这里：取函数名之后第一个 `{`，撞上的是
     * `input: {` 那一段类型声明 —— 于是「函数体」变成了类型声明，
     * 里面当然没有任何写操作，检查器**静默漏报**。
     * 而这个项目里几乎每个 server action 都是这么写的：
     * 修好之后当场又查出三处漏记。
     */
    const source = `
      export async function f(input: { id: string; note: string }) {
        await requireAdmin("x.y");
        db.update(users).set({ a: 1 }).run();
      }
    `;
    const [fn] = splitFunctions(source);
    assert.match(fn.body, /requireAdmin/, "函数体被截成了参数类型");
    assert.equal(auditGaps("f.ts", source).length, 1, "带内联参数类型的函数被漏掉了");
  });

  it("返回类型里的花括号也不能", () => {
    const source = `
      export async function f(id: string): Promise<{ ok: boolean }> {
        await requireAdmin("x.y");
        db.insert(users).values({}).run();
      }
    `;
    assert.equal(auditGaps("f.ts", source).length, 1);
  });
});

describe("辅助判定", () => {
  it("认得出 requireAdmin", () => {
    assert.equal(requiresAdmin('await requireAdmin("x")'), true);
    assert.equal(requiresAdmin("await getCurrentUser()"), false);
  });

  it("认得出委托", () => {
    assert.equal(delegatesAudit("await changeSetting({})"), "changeSetting");
    assert.equal(delegatesAudit("await somethingElse()"), null);
  });
});
