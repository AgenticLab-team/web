import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { DELETION_PLAN, MUST_DISCLOSE, planFor, PURGE_TABLES } from "@/lib/users/deletion-plan";
import { repoRoot } from "./_source";

/**
 * 注销账号的处置登记表。
 *
 * ─────────────────────────────────────────
 * 为什么这张表值得用测试钉住
 * ─────────────────────────────────────────
 *
 * 库里有 60 多张表引用「人」。注销写成一串 DELETE 的话，
 * **新加的表不会有任何提示** —— 半年后某个新功能建了张带 user_id 的表，
 * 注销时它就被漏下了，而一个注销过的人痕迹还留在库里，
 * 没有任何地方看得出来。
 *
 * 所以这里从 schema 里**扫出全部引用「人」的表**，逐一比对登记表：
 * 漏一张就红。和 DEAD_COLUMNS 是同一套办法。
 *
 * ─────────────────────────────────────────
 * 第二要紧的是「说清楚」
 * ─────────────────────────────────────────
 *
 * 用户会以为注销能删掉自己的微信发言。删不掉 —— 那些消息是从上游
 * 同步下来的镜像，删了下次同步会回来，而且它们是**群的记录**。
 *
 * 这件事必须在他按下确认**之前**说明白。等他发现时，
 * 已经没有账号可以登回来问了。
 */

const SCHEMA_DIR = join(repoRoot, "src/lib/db/schema");

/** 引用「人」的列 —— 出现任意一个，这张表就得有处置 */
const PERSON_COLUMNS = [
  "user_id",
  "author_id",
  "wx_id",
  "actor_id",
  "created_by",
  "granted_by",
  "deleted_by",
  "reporter_id",
  "handled_by",
  "inviter_id",
  "from_user_id",
  "to_user_id",
  "sharer_wx_id",
  "sender_wx_id",
  "featured_by",
];

/**
 * 按 `sqliteTable(` 切段，而不是拿正则去匹配整段表定义。
 *
 * ─────────────────────────────────────────
 * 第一版正是在这里悄悄漏了一张表
 * ─────────────────────────────────────────
 *
 * 原来写的是 `sqliteTable\(\s*"(\w+)"([\s\S]*?)\n\);` ——
 * 靠「下一个顶格的 `);`」当结束标记。而 `user_privacy` 的定义**不是**
 * 那样收尾的，于是这一段一路吃到了 `user_notes` 的收尾，
 * **把整张 user_notes 吞掉了**。
 *
 * 更值得记的是：下面那条「扫描本身没坏」的守卫**照样是绿的** ——
 * 它只查「扫出来的表够不够多」，而 60 张里少 1 张够不到任何阈值。
 * 一个阈值守卫防得住解析整体崩掉，防不住少一个。
 *
 * 切段就没有这个问题：每一段从一个 `sqliteTable(` 开始，到下一个为止。
 */
function tableSegments(body: string): { table: string; cols: string }[] {
  const marks = [...body.matchAll(/sqliteTable\(\s*"(\w+)"/g)];
  return marks.map((m, i) => ({
    table: m[1],
    cols: body.slice(m.index!, i + 1 < marks.length ? marks[i + 1].index! : body.length),
  }));
}

function allTables(): string[] {
  const out: string[] = [];
  for (const file of readdirSync(SCHEMA_DIR)) {
    if (!file.endsWith(".ts")) continue;
    out.push(...tableSegments(readFileSync(join(SCHEMA_DIR, file), "utf8")).map((t) => t.table));
  }
  return out;
}

function tablesReferencingPeople(): string[] {
  const found: string[] = [];
  for (const file of readdirSync(SCHEMA_DIR)) {
    if (!file.endsWith(".ts")) continue;
    for (const { table, cols } of tableSegments(readFileSync(join(SCHEMA_DIR, file), "utf8"))) {
      if (PERSON_COLUMNS.some((c) => cols.includes(`text("${c}")`))) found.push(table);
    }
  }
  return found;
}

const REFERENCING = tablesReferencingPeople();
const ALL_TABLES = allTables();

describe("扫描本身没坏", () => {
  it("**真的扫出了一批表** —— 正则退化的话下面每一条都会假绿", () => {
    /*
     * 这一条防的是最阴的那种失败：解析匹配不上 → 一张表都没扫出来 →
     * 「每张表都有处置」自动成立 → 整套测试变成空转。
     */
    assert.ok(REFERENCING.length > 50, `只扫出 ${REFERENCING.length} 张表，解析八成退化了`);
  });

  it("扫得出几个已知的", () => {
    for (const t of ["users", "sessions", "forum_posts", "messages", "audit_logs", "user_notes"]) {
      assert.ok(REFERENCING.includes(t), `没扫到 ${t}`);
    }
  });

  it("**一张表都不许被解析吞掉** —— 阈值守卫防不住「少一个」", () => {
    /*
     * 第一版的正则把 user_notes 整张吞了，而上面那条「够不够多」
     * 的守卫照样是绿的：60 张里少 1 张够不到任何阈值。
     *
     * 这一条改成拿**同一份文件里 sqliteTable( 出现的次数**做基准 ——
     * 少一个就对不上。
     */
    let declared = 0;
    for (const file of readdirSync(SCHEMA_DIR)) {
      if (!file.endsWith(".ts")) continue;
      declared += (readFileSync(join(SCHEMA_DIR, file), "utf8").match(/sqliteTable\(/g) ?? [])
        .length;
    }
    assert.equal(ALL_TABLES.length, declared, "有表在解析时被吞掉了");
  });
});

describe("**每一张引用「人」的表都要有处置**", () => {
  it("一张都不许漏", () => {
    const missing = REFERENCING.filter((t) => !planFor(t));
    assert.deepEqual(
      missing,
      [],
      `这些表引用了「人」，却没写明注销时怎么办：${missing.join("、")}\n` +
        "新加表时必须在 lib/users/deletion-plan.ts 里补一条 —— " +
        "漏掉的话，注销过的人的痕迹会留在库里，而没有任何地方看得出来",
    );
  });

  it("**登记表里不许有已经不存在的表**", () => {
    /*
     * 表删了、处置留着的话，读的人会以为还有那么个东西。
     *
     * 带 `via` 的那些例外：它们不直接写「人」（keyword_hits 只有
     * sub_id），扫描发现不了，但确实属于某个账号 —— 所以只要
     * 那张表本身还在就算数。
     */
    const ghosts = DELETION_PLAN.filter(
      (p) => !REFERENCING.includes(p.table) && !ALL_TABLES.includes(p.table),
    ).map((p) => p.table);
    assert.deepEqual(ghosts, [], `这些表已经不存在了：${ghosts.join("、")}`);
  });

  it("**间接挂靠的必须写明挂在谁下面**", () => {
    /*
     * 没有 via 的话，一张不直接写人的表混在登记表里，
     * 下一个人会以为扫描漏了它，然后去「修」扫描。
     */
    for (const p of DELETION_PLAN) {
      if (REFERENCING.includes(p.table)) continue;
      assert.ok(p.via, `${p.table} 不直接引用「人」，却没写明挂在哪张表下面`);
      assert.ok(ALL_TABLES.includes(p.via!.table), `${p.table} 挂靠的 ${p.via!.table} 不存在`);
    }
  });

  it("**每一条都写得出为什么**", () => {
    for (const p of DELETION_PLAN) {
      assert.ok(p.why.length > 15, `${p.table} 的理由太短，等于没写`);
    }
  });
});

describe("**几条不能错的处置**", () => {
  it("群聊那一侧一个字都不动", () => {
    /*
     * messages 是上游镜像 —— 删掉的行下一轮同步会原样回来，
     * 既破坏归档又白费力气。而且那是群的记录，不是这个站的。
     */
    for (const t of ["messages", "daily_stats", "people", "group_members", "season_standings"]) {
      assert.equal(planFor(t)?.disposition, "wx-space", `${t} 的处置不对 —— 群聊那一侧不能删`);
    }
  });

  it("**会话和凭证必须删** —— 否则注销之后旧 cookie 还能进来", () => {
    for (const t of ["sessions", "credentials", "bind_codes"]) {
      assert.equal(planFor(t)?.disposition, "purge", `${t} 没被删，注销等于没注销`);
    }
  });

  it("**带 token 的那张必须删**", () => {
    assert.equal(planFor("github_connections")?.disposition, "purge");
  });

  it("**权限必须跟着账号消失**", () => {
    for (const t of ["user_roles", "permission_overrides"]) {
      assert.equal(planFor(t)?.disposition, "purge", `${t} 留着是最危险的一种残留`);
    }
  });

  it("**推送订阅必须删** —— 账号注销了设备还在响是最刺眼的残留", () => {
    assert.equal(planFor("push_subscriptions")?.disposition, "purge");
  });

  it("**审计与账目不许被当事人抹掉**", () => {
    /*
     * 一个管理员做了事再注销账号、记录跟着消失 ——
     * 那正是审计要防的情形。积分流水同理：抹掉一个人的流水，
     * 全站总额就对不上了，而对不上没有任何地方看得出来。
     */
    for (const t of ["audit_logs", "moderation_actions", "points_ledger", "reports", "appeals"]) {
      assert.equal(planFor(t)?.disposition, "keep", `${t} 可以被注销抹掉的话，它就失去意义了`);
    }
  });

  it("**邀请关系要留** —— 删掉就能注销重注册反复领奖励", () => {
    assert.equal(planFor("invite_uses")?.disposition, "keep");
  });

  it("**帖子和回复是抹名字，不是删内容**", () => {
    /*
     * 删帖会毁掉别人的对话：一个引发了三十条回复的帖子消失之后，
     * 那三十条就成了自言自语。
     */
    assert.equal(planFor("forum_posts")?.disposition, "anonymize");
    assert.equal(planFor("forum_replies")?.disposition, "anonymize");
  });

  it("**users 那一行留着壳** —— 删行会让所有 keep 的引用指向虚空", () => {
    /*
     * 审计日志翻出来是一串查不到人的 id。留一行标着 deleted 的壳，
     * 那些引用才有落点，而能认出是谁的字段全部清掉。
     */
    assert.equal(planFor("users")?.disposition, "anonymize");
  });

  it("PURGE_TABLES 和登记表对得上", () => {
    assert.deepEqual(
      [...PURGE_TABLES].sort(),
      DELETION_PLAN.filter((p) => p.disposition === "purge")
        .map((p) => p.table)
        .sort(),
    );
  });
});

describe("**确认之前必须说清楚的事**", () => {
  it("三条都在", () => {
    assert.deepEqual(
      MUST_DISCLOSE.map((d) => d.key).sort(),
      ["chat-stays", "irreversible", "posts-anonymized"],
    );
  });

  it("**第一条就是「群聊记录不会删除」**", () => {
    /*
     * 这是用户最可能误解的一件事，也是发现得最晚的一件事 ——
     * 等他发现时已经没有账号可以登回来问了。所以它排在最前面。
     */
    assert.equal(MUST_DISCLOSE[0].key, "chat-stays");
    assert.match(MUST_DISCLOSE[0].detail, /微信/);
    assert.match(MUST_DISCLOSE[0].detail, /同步/);
  });

  it("**每条都说了「为什么」，不只是「会怎样」**", () => {
    for (const d of MUST_DISCLOSE) {
      assert.ok(d.detail.length > 25, `${d.key} 只说了结果没说原因`);
    }
  });

  it("**明说不可撤销**", () => {
    const irreversible = MUST_DISCLOSE.find((d) => d.key === "irreversible")!;
    assert.match(irreversible.text, /不可撤销/);
  });
});
