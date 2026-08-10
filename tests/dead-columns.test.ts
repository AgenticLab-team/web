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

/**
 * src 里出现过这个列名的任何一种写法。
 *
 * ─────────────────────────────────────────
 * schema 文件整体排除，但**索引定义要算**
 * ─────────────────────────────────────────
 *
 * 一个只出现在 `index(...).on(t.xxx)` 里的列不是死列 ——
 * 它在为查询排序或过滤，删掉它索引就得跟着改。
 *
 * 漏掉这一条真的坑过一次：`group_member_events.detected_at`
 * 被报成「一次都没出现过」，我据此写下「它和 created_at 重复」——
 * 而那张表**根本没有 created_at**：detected_at 是它唯一的时间戳，
 * 还在 `gme_conv_idx` 里。差一点就把它删了。
 */
function referenced(): (t: Table, ts: string) => boolean {
  const schemaFiles = new Set(walk(SCHEMA_DIR));

  /* 从 schema 文件里只取索引定义那一段，其余照旧排除 */
  const indexUse = [...schemaFiles]
    .flatMap((f) => [
      ...readFileSync(f, "utf8").matchAll(/(?:unique)?[iI]ndex\([^)]*\)\s*\.on\(([^)]*)\)/g),
    ])
    .map((m) => m[1])
    .join(" ");

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
  /*
   * 索引只在**这张表本身被用到**时才算数。
   *
   * `user_identities` 整张表没有任何地方引用（GitHub 绑定走的是
   * `github_connections`），而它自己身上是有索引的 ——
   * 认索引就等于让一张死表把它所有的列都洗白，
   * 而那正是这条测试要抓的东西。
   */
  const tableAlive = (t: Table) => new RegExp(`\\b${t.varName}\\b`).test(body);

  return (t, ts) =>
    (tableAlive(t) && new RegExp(`\\b${ts}\\b`).test(indexUse)) ||
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
    assert.ok(t?.cols.some((c) => c.sql === "hide_from_leaderboard"), "列名映射坏了");
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

describe("**真删掉的那两个不会再回来**", () => {
  /*
   * `duplicate` 那一类的定义就是「同一件事已经有别的列在管」——
   * 它最该删，因为它随时会被谁接上，接上就是两套开关管一件事，
   * 只拨了其中一个的人以为自己设好了。
   *
   * 删是靠 `ALTER TABLE ... DROP COLUMN`（SQLite 3.35+，
   * 线上是 3.53）。删之前在**从真备份恢复出来的副本**上跑过一遍：
   * 56 篇帖子、45512 条消息一条不少，完整性检查 ok。
   */
  const schemaText = walk(SCHEMA_DIR)
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");

  for (const [col, instead] of [
    ["hideFromDirectory", "users.directoryHidden"],
    ["pinnedGlobally", "站内公告"],
  ]) {
    it(`${col} 不在 schema 里了 —— 这件事由 ${instead} 管`, () => {
      assert.equal(schemaText.includes(col), false, `${col} 又回到 schema 里了`);
    });
  }

  it("迁移文件里是 DROP COLUMN，不是重建整张表", () => {
    /*
     * 重建整张表要把数据搬一遍，而 forum_posts 里是真内容。
     * SQLite 3.35 起支持原地删列，两条语句的事。
     */
    const sql = readFileSync(new URL("../drizzle/0048_damp_skin.sql", import.meta.url), "utf8");
    assert.match(sql, /ALTER TABLE `user_privacy` DROP COLUMN `hide_from_directory`/);
    assert.match(sql, /ALTER TABLE `forum_posts` DROP COLUMN `pinned_globally`/);
    assert.equal(/CREATE TABLE/.test(sql), false, "变成重建表了");
  });
});

describe("**索引里用到的列不算死列**", () => {
  it("group_member_events.detected_at 被认成在用", () => {
    /*
     * 它只出现在 `index("gme_conv_idx").on(t.convId, t.detectedAt)` 里。
     * 探测器漏掉这种用法时，它被报成「一次都没出现过」，
     * 我据此写下「和 created_at 重复」—— 而那张表根本没有 created_at。
     * 差一点就把一张表唯一的时间戳删了。
     */
    const t = ALL.find((x) => x.sqlName === "group_member_events")!;
    assert.equal(isRead(t, "detectedAt"), true);
  });

  it("**但一张死表的索引救不活它**", () => {
    /*
     * 这一条原来拿 `user_identities` 当例子 —— 那张表整张没人用
     * （GitHub 绑定走 github_connections），而它自己身上有索引。
     * 认索引就等于让一张死表把它所有的列都洗白。
     *
     * 那张表现在已经删掉了，所以改成造一张**根本不存在**的表来测规则
     * 本身。列名故意用上一条那个 `detectedAt`：它在真 schema 里只出现在
     * 索引定义里，别处一次都没有 —— 于是这两条构成一对干净的对照：
     *
     *   同一个列名，**活表** → 算在用（上一条）
     *   同一个列名，**死表** → 判死（这一条）
     *
     * 差别只有「这张表有没有人用」，正是要守的那条规则。
     *
     * 拿真表当例子有个坏处：那张表哪天被用起来，这条测试就红了，
     * 而红的原因和它要守的规则毫无关系。
     */
    const ghost: (typeof ALL)[number] = {
      varName: "tableThatDoesNotExistAnywhere",
      sqlName: "ghost_table",
      cols: [{ ts: "detectedAt", sql: "detected_at" }],
    };
    assert.equal(isRead(ghost, "detectedAt"), false, "死表被索引洗白了");
  });
});
