import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  EXPORT_COLUMNS,
  buildCsv,
  contentDisposition,
  csvCell,
  csvTime,
  exportFilename,
  isExportScope,
  type ExportRow,
} from "@/lib/activities/export-rules";

/**
 * 导出域名申请清单。
 *
 * ─────────────────────────────────────────
 * 已经有一个「导出」，但它只有域名
 * ─────────────────────────────────────────
 *
 * `exportRegistrarList` 吐一列光秃秃的域名，粘进注册商的批量框 ——
 * 那条路径没问题。问题是注册完之后「这个域名是谁的」它答不上来，
 * 管理员只能回后台一条条点开看。
 *
 * 这份是另一个东西：能存下来、能用表格打开、能对账的清单。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

const row = (over: Partial<ExportRow> = {}): ExportRow => ({
  domain: "foo.icu",
  status: "approved",
  applicantName: "阿猫",
  userId: "u_1",
  createdAt: Date.UTC(2026, 7, 9, 15, 31),
  reviewedAt: null,
  fulfilledAt: null,
  failureReason: null,
  ...over,
});

describe("**昵称是用户自己填的，而 Excel 会把它当公式执行**", () => {
  /*
   * 这是这个文件里最要紧的一组。一个把昵称改成 `=cmd|'/c calc'!A1`
   * 的人，导出的表在 Excel / WPS 里打开会弹「是否允许」——
   * 而管理员对着一份自己刚从后台导出的文件，多半会点允许。
   */
  for (const bad of ["=1+1", "+1", "-1", "@SUM(A1)", "\t=1", "\r=1"]) {
    it(`以 ${JSON.stringify(bad[0])} 开头的要退回成纯文本`, () => {
      assert.equal(csvCell(bad).startsWith("'") || csvCell(bad).startsWith(`"'`), true, bad);
    });
  }

  it("**引号转义挡不住这个** —— 包起来的公式在 Excel 眼里照样是公式", () => {
    /*
     * `"=1+1"` 只是 CSV 语法上的合法字段，电子表格照样求值。
     * 所以单引号必须加在**引号里面**，紧贴内容。
     */
    assert.equal(csvCell("=1+1,2"), `"'=1+1,2"`);
  });

  it("只动开头那一个字符，不改内容", () => {
    // 昵称就叫「=不等于=」的人，导出来还得是他自己那个名字
    assert.equal(csvCell("=不等于="), "'=不等于=");
  });

  it("正常昵称不加那个引号 —— 否则每个人的名字前面都多一撇", () => {
    assert.equal(csvCell("阿猫"), "阿猫");
    assert.equal(csvCell("a-b"), "a-b", "横杠在中间不算公式");
  });
});

describe("CSV 本身的转义", () => {
  it("含逗号的要包起来", () => {
    assert.equal(csvCell("北京, 中国"), `"北京, 中国"`);
  });

  it("含引号的要包起来并且引号翻倍", () => {
    assert.equal(csvCell(`他说"好"`), `"他说""好"""`);
  });

  it("**含换行的要包起来** —— 不然一条申请会变成两行", () => {
    assert.equal(csvCell("上\n下"), `"上\n下"`);
  });

  it("空和 null 都是空格子，不是「null」四个字母", () => {
    assert.equal(csvCell(null), "");
    assert.equal(csvCell(undefined), "");
    assert.equal(csvCell(""), "");
  });
});

describe("时间", () => {
  it("**按东八区写** —— UTC 会让晚上 8 点之后的申请看起来像第二天的", () => {
    assert.equal(csvTime(Date.UTC(2026, 7, 9, 15, 31)), "2026-08-09 23:31");
  });

  it("没有的时间留空，不写 1970", () => {
    assert.equal(csvTime(null), "");
    assert.equal(csvTime(0), "");
  });
});

describe("整份文件", () => {
  it("**开头有 BOM** —— 没有它 Excel 会把中文昵称读成乱码", () => {
    /*
     * 管理员看到一整列方块字不会去想编码，他会觉得这个导出坏了。
     */
    assert.equal(buildCsv([]).startsWith("﻿"), true);
  });

  it("行尾是 CRLF", () => {
    assert.match(buildCsv([row()]), /\r\n/);
  });

  it("表头是中文，且和列的顺序一致", () => {
    const first = buildCsv([]).replace("﻿", "").split("\r\n")[0];
    assert.equal(first, EXPORT_COLUMNS.join(","));
    assert.equal(first.includes("申请人"), true);
  });

  it("状态写中文，不写 fulfilled", () => {
    assert.match(buildCsv([row({ status: "fulfilled" })]), /已完成/);
    assert.equal(buildCsv([row({ status: "fulfilled" })]).includes(",fulfilled,"), false);
  });

  it("一条申请就是一行", () => {
    const lines = buildCsv([row(), row({ domain: "bar.icu" })]).trimEnd().split("\r\n");
    assert.equal(lines.length, 3, "表头 + 两条");
  });

  it("**空清单也要有表头** —— 一个 0 字节的文件看起来像下载失败", () => {
    assert.equal(buildCsv([]).replace("﻿", "").trimEnd(), EXPORT_COLUMNS.join(","));
  });

  it("失败原因带逗号也不会把列冲乱", () => {
    const csv = buildCsv([row({ status: "failed", failureReason: "已被抢注, 换一个" })]);
    const line = csv.trimEnd().split("\r\n")[1];
    // 包起来之后，行里的逗号不再是分隔符
    assert.match(line, /"已被抢注, 换一个"/);
  });
});

describe("文件名", () => {
  it("**带活动、档位和日期** —— 管理员会导好几次", () => {
    // 全都叫 export.csv 的话，下载目录里躺着 export(3).csv，没人分得清哪份是哪次
    assert.equal(exportFilename("域名注册", "pending", "2026-08-09"), "域名注册-待注册-2026-08-09.csv");
  });

  it("活动标题里的斜杠之类要换掉，否则有的系统存不下来", () => {
    assert.equal(exportFilename("A/B:C", "all", "2026-08-09"), "A-B-C-全部-2026-08-09.csv");
  });

  it("标题是空的也得有个名字", () => {
    assert.match(exportFilename("   ", "fulfilled", "2026-08-09"), /^活动-已注册/);
  });

  it("**中文文件名要走 filename\\*=UTF-8** —— 只写 filename= 会存成乱码", () => {
    const value = contentDisposition("域名-待注册.csv");
    assert.match(value, /filename\*=UTF-8''/);
    assert.match(value, /filename="/);
  });

  it("退化的那个 filename 里不留裸引号 —— 那会把这个头拆坏", () => {
    assert.equal(contentDisposition('a"b.csv').includes('"a"b.csv"'), false);
  });
});

describe("档位", () => {
  it("认得三档", () => {
    for (const s of ["pending", "fulfilled", "all"]) assert.equal(isExportScope(s), true);
  });

  it("别的一律不认 —— 参数是从 URL 来的", () => {
    assert.equal(isExportScope("__proto__"), false);
    assert.equal(isExportScope("constructor"), false);
    assert.equal(isExportScope(null), false);
  });
});

describe("接线", () => {
  it("**导出的文件里没有微信 ID**", () => {
    /*
     * 后台里看得到它，那是在登录态下看一眼；
     * 一个 CSV 落到本地之后就再也不受这套权限管了。
     */
    const rules = strip(src("lib/activities/export-rules.ts"));
    const query = strip(src("lib/activities/export.ts"));
    assert.equal(rules.includes("wxId"), false);
    assert.equal(query.includes("users.wxId"), false);
  });

  it("没权限回 404 而不是 403 —— 后台有哪些能力本身也是信息", () => {
    const route = strip(src("app/api/admin/activities/[id]/domains/route.ts"));
    assert.match(route, /status: 404/);
    assert.equal(route.includes("403"), false);
  });

  it("要校验权限，而且是履约那一项", () => {
    const route = strip(src("app/api/admin/activities/[id]/domains/route.ts"));
    assert.match(route, /can\(user, "activity\.fulfill"\)/);
  });

  it("**导出要记审计** —— 事后唯一能回答「这份表从哪来的」的记录", () => {
    const route = strip(src("app/api/admin/activities/[id]/domains/route.ts"));
    assert.match(route, /audit\(/);
    // 记条数不记内容：把整份名单再抄一遍等于又造一份同样敏感的副本
    assert.match(route, /rows: rows\.length/);
  });

  it("不许被缓存", () => {
    assert.match(strip(src("app/api/admin/activities/[id]/domains/route.ts")), /no-store/);
  });

  it("规则层是纯的 —— 否则测不了", () => {
    const rules = src("lib/activities/export-rules.ts");
    for (const forbidden of ["server-only", "@/lib/db", "drizzle-orm"]) {
      assert.equal(rules.includes(forbidden), false, `规则层引了 ${forbidden}`);
    }
  });
});

/* ───────────────────────────────────────────────────────────────
 * 真数据库
 * ─────────────────────────────────────────────────────────────── */

const tmp = mkdtempSync(join(tmpdir(), "al-export-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

let dbm: typeof import("@/lib/db");
let schema: typeof import("@/lib/db/schema");
let exp: typeof import("@/lib/activities/export");
let queries: typeof import("@/lib/activities/queries");

const ACT = "act_1";

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  exp = await import("@/lib/activities/export");
  queries = await import("@/lib/activities/queries");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

const app = (over: { id: string; key: string; status: string; userId?: string; createdAt?: number }) =>
  dbm.db
    .insert(schema.activityApplications)
    .values({
      id: over.id,
      activityId: ACT,
      userId: over.userId ?? "u_1",
      normalizedKey: over.key,
      status: over.status as "approved",
      createdAt: over.createdAt ?? 1,
      updatedAt: 1,
    })
    .run();

beforeEach(() => {
  dbm.db.delete(schema.activityApplications).run();
  dbm.db.delete(schema.activities).run();
  dbm.db.delete(schema.users).run();
  dbm.db
    .insert(schema.users)
    .values({ id: "u_1", wxId: "wx_1", siteNickname: "阿猫", status: "active" })
    .run();
  dbm.db
    .insert(schema.activities)
    .values({ id: ACT, title: "域名注册", moduleKey: "domain", status: "open", createdBy: "u_1" })
    .run();
});

describe("捞数据（真库）", () => {
  it("待注册那一档 = 已通过 + 履约中", () => {
    app({ id: "a1", key: "a.icu", status: "approved" });
    app({ id: "a2", key: "b.icu", status: "fulfilling" });
    app({ id: "a3", key: "c.icu", status: "cancelled" });

    const domains = exp.domainExportRows(ACT, "pending").map((r) => r.domain);
    assert.deepEqual(domains, ["a.icu", "b.icu"]);
  });

  it("全部那一档连撤回和失败一起导 —— 复盘要看的正是这些", () => {
    app({ id: "a1", key: "a.icu", status: "approved" });
    app({ id: "a3", key: "c.icu", status: "cancelled" });
    assert.equal(exp.domainExportRows(ACT, "all").length, 2);
  });

  it("**顺序和给注册商那份一致** —— 不然管理员会以为中间少了几条", () => {
    app({ id: "a2", key: "b.icu", status: "approved", createdAt: 200 });
    app({ id: "a1", key: "a.icu", status: "approved", createdAt: 100 });

    const mine = exp.domainExportRows(ACT, "pending").map((r) => r.domain);
    const theirs = queries.exportRegistrarList(ACT, "pending").split("\n");
    assert.deepEqual(mine, theirs);
  });

  it("**注销的人的申请不能从导出里消失**", () => {
    /*
     * 那条申请对应的域名可能已经注册出去了。
     * 用 innerJoin 的话它在对账表里查无此条 —— 最难查的那种账。
     */
    app({ id: "a1", key: "a.icu", status: "fulfilled", userId: "u_gone" });
    const rows = exp.domainExportRows(ACT, "fulfilled");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].applicantName, null, "认不出名字，但用户 ID 还在");
    assert.equal(rows[0].userId, "u_gone");
  });

  it("自设昵称优先于微信昵称", () => {
    dbm.db.delete(schema.users).run();
    dbm.db
      .insert(schema.users)
      .values({ id: "u_1", wxId: "wx_1", wxNickname: "微信名", siteNickname: "站内名", status: "active" })
      .run();
    app({ id: "a1", key: "a.icu", status: "approved" });
    assert.equal(exp.domainExportRows(ACT, "pending")[0].applicantName, "站内名");
  });

  it("每一档的条数对得上各自导出来的行数", () => {
    app({ id: "a1", key: "a.icu", status: "approved" });
    app({ id: "a2", key: "b.icu", status: "fulfilled" });
    app({ id: "a3", key: "c.icu", status: "cancelled" });

    const counts = exp.domainExportCounts(ACT);
    for (const scope of ["pending", "fulfilled", "all"] as const) {
      assert.equal(counts[scope], exp.domainExportRows(ACT, scope).length, scope);
    }
  });

  it("活动不存在时拿不到标题 —— 路由据此回 404", () => {
    assert.equal(exp.activityTitle("nope"), null);
    assert.equal(exp.activityTitle(ACT), "域名注册");
  });

  it("端到端：捞出来能直接拼成一份带中文的 CSV", () => {
    app({ id: "a1", key: "a.icu", status: "approved" });
    const csv = buildCsv(exp.domainExportRows(ACT, "pending"));
    assert.match(csv, /a\.icu/);
    assert.match(csv, /阿猫/);
    assert.match(csv, /已通过/);
    assert.equal(csv.includes("wx_1"), false, "微信 ID 漏进导出了");
  });
});
