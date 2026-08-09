import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { DEAD_COLUMNS } from "@/lib/db/dead-columns";

/**
 * 建了、没人读的列。
 *
 * ─────────────────────────────────────────
 * 1058 列里有 23 列 src 里一次都没出现过
 * ─────────────────────────────────────────
 *
 * 一列空着不花钱，问题不在存储 —— 在于**它看起来是做过的**。
 *
 * 下一个人读到 `invites.grant_role_id`，合理的结论是
 * 「邀请码能带角色」；读到 `user_privacy.hide_from_directory`，
 * 合理的结论是「隐私设置里有这一项」。两个结论都是错的，
 * 而代码没有一处告诉他。
 *
 * ─────────────────────────────────────────
 * 这条测试要的不是「删干净」，是「说得出实情」
 * ─────────────────────────────────────────
 *
 * 删列在 SQLite 上要重建整张表，比删一行配置重得多，
 * 而且有些确实是功能还没做。所以这里只逼一件事：
 * **每一列都得有人给出过一句实情**。
 *
 * 新出现一列没人读的 → 这里红。
 * 名单上的某一列被接上了 → 这里也红（该把它从名单上划掉）。
 */

const root = new URL("..", import.meta.url).pathname;
const SCHEMA_DIR = join(root, "src/lib/db/schema");

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
 * 从 `{` 起按括号配对切出对象字面量，取深度 1 上的 `键:`。
 *
 * 用正则去匹配整段表定义是行不通的：列的定义里有嵌套的
 * `{ mode: "timestamp" }`、`{ enum: [...] }`，非贪婪匹配会在
 * 第一个 `}` 上就停下，于是一张表只认出前两列 ——
 * 而漏掉的列会被当成「不存在」，静悄悄地不受这条测试管。
 */
function columnsAt(src: string, openIdx: number): string[] {
  let depth = 0;
  const keys: string[] = [];
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") {
      depth--;
      if (depth === 0) break;
    } else if (depth === 1 && /[A-Za-z_$]/.test(ch)) {
      const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(src.slice(i, i + 60));
      if (m && /[\n{,]\s*$/.test(src.slice(Math.max(0, i - 40), i))) keys.push(m[1]);
      while (i < src.length && /[\w$]/.test(src[i])) i++;
      i--;
    }
  }
  return keys;
}

interface Table {
  varName: string;
  sqlName: string;
  cols: { ts: string; sql: string }[];
}

function tables(): Table[] {
  const out: Table[] = [];
  for (const file of walk(SCHEMA_DIR)) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/export const (\w+) = sqliteTable\(\s*\n?\s*"(\w+)",\s*\n?\s*\{/g)) {
      const open = m.index + m[0].length - 1;
      const body = src.slice(open, open + 20_000);
      const cols = columnsAt(src, open).map((ts) => {
        // 列在库里的名字来自 `text("xxx")` / `integer("xxx")` 那个参数
        const decl = new RegExp(`\\b${ts}\\s*:[^,]*?\\(\\s*"([\\w]+)"`).exec(body);
        return { ts, sql: decl?.[1] ?? ts };
      });
      out.push({ varName: m[1], sqlName: m[2], cols });
    }
  }
  return out;
}

const ALL = tables();

/** src 里（除 schema 之外）出现过这个列名的任何一种写法 */
function referenced(): (t: Table, ts: string) => boolean {
  const schemaFiles = new Set(walk(SCHEMA_DIR));
  const body = walk(join(root, "src"))
    .filter((f) => !schemaFiles.has(f) && !f.endsWith("db/dead-columns.ts"))
    .map((f) => readFileSync(f, "utf8"))
    .join("\n")
    /*
     * 把 `col: null` 这种写法先去掉再判。
     *
     * `users.phone_verified_at` 全站只出现一次，是解绑手机号时
     * 顺手清空它 —— 从来没被写进过值，也从来没被读过。
     * 算成「在用」的话，一个纯粹的空列会因为一句清空语句而免检。
     *
     * 写 null 不是用它。
     */
    .replace(/\b[\w$]+\s*:\s*null\b/g, "");
  return (t, ts) =>
    new RegExp(
      [
        `\\b${t.varName}\\.${ts}\\b`, // posts.shareCode
        `\\b${ts}\\s*:`, //               { shareCode: ... }
        `\\.${ts}\\b`, //                 row.shareCode
        `["']${ts}["']`, //                 "shareCode"
        /*
         * 对象字面量的**简写**：`{ diskTotal, diskUsed }`。
         *
         * 漏掉这一种会把「写了但没读」的列报成「一次都没出现过」——
         * 那是两件不同的事，而后者听起来严重得多。
         * `health.ts` 每次探测都把磁盘数写进快照，就是这么写的。
         */
        `^\\s*${ts}\\s*,\\s*$`,
      ].join("|"),
      "m",
    ).test(body);
}

const isRead = referenced();
const listed = new Map(DEAD_COLUMNS.map((d) => [d.column, d]));

describe("扫描本身没坏", () => {
  it("表和列都数出来了 —— 否则这条测试是在空转", () => {
    /*
     * 这一条防的是「解析悄悄退化」：正则一旦匹配不上，
     * 每张表都会变成 0 列，而所有断言都会通过。
     */
    assert.ok(ALL.length > 80, `只认出 ${ALL.length} 张表`);
    const cols = ALL.reduce((n, t) => n + t.cols.length, 0);
    assert.ok(cols > 900, `只认出 ${cols} 个列 —— 解析八成退化了`);
  });

  it("每张表都至少认出几列", () => {
    // 一张表 0 列就是解析在它身上失败了，而失败是静默的
    const empty = ALL.filter((t) => t.cols.length < 2).map((t) => t.sqlName);
    assert.deepEqual(empty, [], `这些表没认出列来：${empty.join(", ")}`);
  });

  it("库里的列名也解析出来了", () => {
    // 名单上写的是库里的名字（迁移和排查看的是这个），对不上就白记了
    const t = ALL.find((x) => x.sqlName === "user_privacy");
    assert.ok(t?.cols.some((c) => c.sql === "hide_from_directory"), "列名映射坏了");
  });
});

describe("**每一列要么被读，要么在名单上写明实情**", () => {
  for (const t of ALL) {
    for (const c of t.cols) {
      const key = `${t.sqlName}.${c.sql}`;
      it(key, () => {
        if (isRead(t, c.ts)) return;
        assert.ok(
          listed.has(key),
          `${key} 建了但没有任何地方读它。\n` +
            `一列空着不花钱，问题在于它看起来是做过的 —— ` +
            `下一个人会照着它的名字推断出一个不存在的功能。\n` +
            `要么接上，要么写进 src/lib/db/dead-columns.ts 说清楚实情`,
        );
      });
    }
  }
});

describe("**名单不能过期**", () => {
  const known = new Set(ALL.flatMap((t) => t.cols.map((c) => `${t.sqlName}.${c.sql}`)));

  it("名单上的列都还存在", () => {
    // 列删掉之后名单没跟着删，下一个人会去找一个不存在的东西
    for (const d of DEAD_COLUMNS) {
      assert.ok(known.has(d.column), `${d.column} 已经不在 schema 里了，名单该跟着删`);
    }
  });

  it("**名单上的列都还是死的**", () => {
    /*
     * 反向也要盯：接上之后忘了从名单上划掉，
     * 下一个人读到的就是「这一列没人用」—— 而它正在用。
     */
    const alive: string[] = [];
    for (const t of ALL) {
      for (const c of t.cols) {
        const key = `${t.sqlName}.${c.sql}`;
        if (listed.has(key) && isRead(t, c.ts)) alive.push(key);
      }
    }
    assert.deepEqual(alive, [], `这些已经接上了，从 dead-columns.ts 里划掉：${alive.join(", ")}`);
  });

  it("每一条都写了实情，不是只贴了个标签", () => {
    for (const d of DEAD_COLUMNS) {
      assert.ok(d.why.length > 12, `${d.column} 没写清楚为什么`);
    }
  });
});

describe("**同一件事有两列的最该先处理**", () => {
  it("重复的那几列都点名了真正在用的是哪一个", () => {
    /*
     * `duplicate` 是这张表上最贵的一类：它随时会被谁接上，
     * 而接上之后就是两个开关管一件事 ——
     * 只拨了其中一个的人以为自己设好了。
     *
     * 所以这一类必须说出「真正在用的是谁」，
     * 否则「重复」这个判断本身没法复核。
     */
    for (const d of DEAD_COLUMNS.filter((x) => x.disposition === "duplicate")) {
      assert.match(
        d.why,
        /在用的是|用的是|就够了|做得更好|表达同一件事/,
        `${d.column} 标了 duplicate，但没说清跟谁重复`,
      );
    }
  });

  it("**标 gap 的是缺陷，不是遗留** —— 写清楚缺的是什么", () => {
    // gap 和 planned 的区别是：gap 现在就该补，planned 是功能还没排上
    for (const d of DEAD_COLUMNS.filter((x) => x.disposition === "gap")) {
      assert.match(d.why, /本来就该/, `${d.column} 标了 gap 但读起来像 planned`);
    }
  });
});
