import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

/**
 * 文档体系的几条硬规矩。
 *
 * ─────────────────────────────────────────
 * 为什么值得用测试钉住
 * ─────────────────────────────────────────
 *
 * 一次六组并行的核对（14 份 md、3849 行）查出来的最主要的两类错，
 * 都不是「写错了」，而是**结构性的**：
 *
 * ① **没人知道某一份是「打算」还是「现状」。** PLAN 被当成现状读、
 *    SCHEMA 被当成 schema 镜像读 —— 绝大多数误导都由此而来。
 * ② **同一件事在两个地方各打一次勾。** 于是必然分叉：核出 13 条
 *    标着「待办」其实早就上线了，3 处同一件事两个位置状态相反，
 *    还有三个迭代标题写着「未开始」而下面每一条都是 ✅。
 *
 * 这两条靠自觉守不住 —— 半个月后又会烂。所以钉在这儿。
 */

const root = new URL("..", import.meta.url).pathname;

const docs = readdirSync(root).filter((f) => f.endsWith(".md"));

/** 给 AI 读的，由 next dev 自动写回，不归这套规矩管 */
const FOR_AI = new Set(["AGENTS.md", "CLAUDE.md"]);
/** 只有这两份可以出现状态标记 */
const LEDGERS = new Set(["ROADMAP.md", "DONE.md"]);

const read = (f: string) => readFileSync(join(root, f), "utf8");

describe("**每一份都要说清楚：读者是谁、是打算还是现状、什么时候核的**", () => {
  for (const f of docs) {
    if (FOR_AI.has(f)) continue;
    it(`${f} 有头`, () => {
      const head = read(f).split("\n").slice(0, 12).join("\n");
      assert.match(head, /\*\*读者\*\*/, `${f} 没写给谁看`);
      assert.match(head, /\*\*性质\*\*/, `${f} 没说是「打算」还是「现状」`);
      assert.match(head, /\*\*最后核对\*\*/, `${f} 没写核对日期 —— 一份不知道什么时候核过的现状描述，读者只能当它是对的`);
    });
  }
});

describe("**状态只在一个地方打勾**", () => {
  for (const f of docs) {
    if (FOR_AI.has(f) || LEDGERS.has(f)) continue;
    it(`${f} 里不出现勾`, () => {
      const body = read(f);
      /*
       * 别处一律只写「为什么这么设计」。
       * 同一件事在两个文件里各有一个勾，就一定会分叉 ——
       * 而分叉之后没有人知道哪个是真的。
       */
      const marks = [...body.matchAll(/^\s*[-*] \[[ xX]\]/gm)];
      assert.deepEqual(
        marks.map((m) => m[0].trim()),
        [],
        `${f} 里有勾 —— 待办和已完成只该出现在 ROADMAP.md / DONE.md`,
      );
    });
  }
});

describe("拆分之后不许留断链", () => {
  const gone = ["BUILD_PLAN.md", "STATUS.md"];

  it("被拆掉/删掉的文档不再存在", () => {
    for (const f of gone) assert.equal(existsSync(join(root, f)), false, `${f} 还在`);
  });

  it("**代码注释里不许指向已经不存在的文档**", () => {
    /*
     * 代码注释把文档当规格引用（`见 SCHEMA.md §十`）。
     * 拆文档时不同步改，就会造出一批指向空气的引用 ——
     * 而下一个人会花半小时找那份文件。
     */
    const bad: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        if (name.name === "node_modules" || name.name.startsWith(".")) continue;
        const full = join(dir, name.name);
        if (name.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name.name)) {
          const body = readFileSync(full, "utf8");
          for (const f of gone) if (body.includes(f)) bad.push(`${full} → ${f}`);
          // PLAN.md 归档了，指向它要带上 docs/archive/ 前缀
          if (/(?<!archive\/)(?<!-)\bPLAN\.md/.test(body)) bad.push(`${full} → PLAN.md（已归档）`);
        }
      }
    };
    walk(join(root, "src"));
    walk(join(root, "scripts"));
    assert.deepEqual(bad, []);
  });

  it("**文档里提到的代码文件必须真的存在** —— 反方向的断链同样会误导", () => {
    /*
     * 上一条挡的是「代码指向不存在的文档」。这一条是反过来。
     *
     * LESSONS.md 这类文档大量引用具体文件（`见 lib/quality.ts`、
     * `tests/_source.ts` 的 stripComments）—— 那是它的价值所在：
     * 一条读得懂但找不到落点的教训，等于没有。
     *
     * 而代码是会动的：这一轮就删掉了一整张表。文件一旦搬走或改名，
     * 文档不会有任何提示，**只会在下一个人按图索骥时白花半小时**，
     * 然后他会开始怀疑这份文档里别的条目是不是也过期了 ——
     * 一条断链会连累整份文档的可信度。
     */
    const bad: string[] = [];
    for (const f of docs) {
      if (FOR_AI.has(f)) continue;
      const body = read(f);
      /*
       * 只认**明确带目录前缀**的路径（lib/…、src/…、tests/…、scripts/…、
       * ops/…、drizzle/…）。不加这个限制的话，正文里随手写的
       * `a/b` 之类也会被当成路径。
       */
      for (const m of body.matchAll(
        /\b((?:src|lib|tests|scripts|ops|drizzle|app|components)\/[\w./[\]()-]+\.(?:ts|tsx|sql|css|conf|service))/g,
      )) {
        const ref = m[1];
        const candidates = [ref, join("src", ref)];
        if (!candidates.some((c) => existsSync(join(root, c)))) bad.push(`${f} → ${ref}`);
      }
    }
    assert.deepEqual(bad, [], "文档里指向的这些文件不存在了");
  });

  it("归档的那份自己标着「不描述现状」", () => {
    const archived = read("docs/archive/PLAN-2026-08-08.md").slice(0, 600);
    assert.match(archived, /已归档/);
    assert.match(archived, /不描述现状/);
  });
});

describe("README 是入口", () => {
  const readme = read("README.md");

  it("**有一张「从哪读起」的表**", () => {
    // 14 份文档摆在根目录，没有顺序的话新来的人只会挨个点开
    assert.match(readme, /从哪读起/);
  });

  it("指向的每一份都真的存在", () => {
    const linked = [...readme.matchAll(/`([A-Z_]+\.md)`/g)].map((m) => m[1]);
    assert.ok(linked.length >= 6, "「从哪读起」那张表太短了");
    for (const f of new Set(linked)) {
      assert.equal(existsSync(join(root, f)), true, `README 指向了不存在的 ${f}`);
    }
  });

  it("说明了哪几份是给 AI 的 —— 否则会有人往里写给人看的东西", () => {
    assert.match(readme, /AGENTS\.md[^\n]*给 AI|给 AI[^\n]*AGENTS\.md/);
  });
});
