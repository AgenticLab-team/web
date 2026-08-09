import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  parseFulfillText,
  planBulkFulfill,
  type AppLite,
} from "@/lib/activities/bulk-fulfill";

/**
 * 批量注册与回填。
 *
 * 管理员复制一份域名列表去注册商那边批量注册，
 * 回来把结果整段粘回系统。解析要宽容 —— 各家注册商的导出格式
 * 五花八门；但**认不出的东西必须报出来而不能猜**：
 * 把「失败」猜成「成功」，用户会收到一条兑现不了的通知。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-bulk-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

// ── 解析：宽容的部分 ─────────────────────────────────────────

describe("解析：分隔符", () => {
  it("空格分隔", () => {
    const r = parseFulfillText("foo-bar.icu 成功");
    assert.equal(r.entries.length, 1);
    assert.deepEqual([r.entries[0].domain, r.entries[0].success], ["foo-bar.icu", true]);
  });

  it("制表符分隔 —— 从表格里复制出来就是这样", () => {
    const r = parseFulfillText("hello.icu\tfailed");
    assert.equal(r.entries[0].success, false);
  });

  it("半角逗号", () => {
    const r = parseFulfillText("hello.icu,成功");
    assert.equal(r.entries[0].success, true);
  });

  it("**中文逗号** —— 在微信里粘贴，全角标点是常态不是意外", () => {
    const r = parseFulfillText("hello.icu，失败");
    assert.equal(r.entries[0].success, false);
  });

  it("顿号、分号、冒号、竖线都认", () => {
    const r = parseFulfillText("a-a.icu、成功\nb-b.icu；成功\nc-c.icu：成功\nd-d.icu|成功");
    assert.equal(r.entries.length, 4);
    assert.equal(r.problems.length, 0);
  });

  it("多个连续分隔符不产生空字段", () => {
    const r = parseFulfillText("hello.icu ,  成功");
    assert.equal(r.entries[0].success, true);
  });
});

describe("解析：容错", () => {
  it("**只有域名时默认成功** —— 注册商的成功列表往往只有域名", () => {
    const r = parseFulfillText("hello.icu");
    assert.equal(r.entries[0].success, true);
  });

  it("空行和纯空白行跳过，不算错误", () => {
    const r = parseFulfillText("\nhello.icu\n\n   \n\t\nworld.icu\n");
    assert.equal(r.entries.length, 2);
    assert.equal(r.problems.length, 0);
  });

  it("首尾多余空格", () => {
    const r = parseFulfillText("   hello.icu   成功   ");
    assert.equal(r.entries[0].domain, "hello.icu");
  });

  it("全角空格当空格处理 —— 肉眼看不出它和普通空格的区别", () => {
    const r = parseFulfillText("hello.icu　成功");
    assert.equal(r.entries[0].success, true);
  });

  it("大写转小写 —— 域名不分大小写，注册商却常常导出大写", () => {
    const r = parseFulfillText("HELLO.ICU OK");
    assert.deepEqual([r.entries[0].domain, r.entries[0].success], ["hello.icu", true]);
  });

  it("带 http:// / https:// 前缀，甚至带路径", () => {
    const r = parseFulfillText("http://hello.icu 成功\nhttps://world.icu/ 失败");
    assert.equal(r.entries[0].domain, "hello.icu");
    assert.deepEqual([r.entries[1].domain, r.entries[1].success], ["world.icu", false]);
  });

  it("尾随点：DNS 根点和中文句号都去掉", () => {
    const r = parseFulfillText("hello.icu.\nworld.icu。");
    assert.deepEqual(r.entries.map((e) => e.domain), ["hello.icu", "world.icu"]);
  });

  it("状态词带尾随标点 ——「成功。」就是「成功」", () => {
    const r = parseFulfillText("hello.icu 成功。");
    assert.equal(r.entries[0].success, true);
    assert.equal(r.problems.length, 0);
  });

  it("失败原因跟在状态后面，一起带回去给申请人看", () => {
    const r = parseFulfillText("hello.icu,失败,已被抢注");
    assert.equal(r.entries[0].note, "已被抢注");
  });

  it("Windows 换行（\\r\\n）", () => {
    const r = parseFulfillText("hello.icu 成功\r\nworld.icu 失败");
    assert.equal(r.entries.length, 2);
  });
});

describe("解析：不能猜的部分", () => {
  it("**认不出的状态词报错，绝不默认成功**", () => {
    // 把「pending」猜成成功，用户会收到一条兑现不了的「注册好了」通知
    const r = parseFulfillText("hello.icu pending");
    assert.equal(r.entries.length, 0);
    assert.equal(r.problems.length, 1);
    assert.match(r.problems[0].reason, /pending/);
  });

  it("**「未成功」是失败** —— 模糊匹配会因为它包含「成功」而判反", () => {
    const r = parseFulfillText("hello.icu 未成功");
    assert.equal(r.entries[0].success, false);
  });

  it("认不出域名的行报错并带行号，人要能对回粘贴的原文", () => {
    const r = parseFulfillText("hello.icu 成功\n？？？ 成功\nworld.icu 成功");
    assert.equal(r.entries.length, 2);
    assert.equal(r.problems[0].line, 2);
  });

  it("没有后缀的裸词不算域名 —— 多半是粘错了列", () => {
    const r = parseFulfillText("hello 成功");
    assert.equal(r.entries.length, 0);
    assert.equal(r.problems.length, 1);
  });

  it("**重复行结果一致：合并成一条**，并记下来让计数对得上", () => {
    const r = parseFulfillText("hello.icu 成功\nhello.icu 成功\nhello.icu");
    assert.equal(r.entries.length, 1);
    assert.deepEqual(r.duplicates, ["hello.icu"]);
  });

  it("**重复行结果矛盾：两行都不执行** —— 挑哪行执行都是替人做决定", () => {
    const r = parseFulfillText("hello.icu 成功\nhello.icu 失败");
    assert.equal(r.entries.length, 0);
    assert.equal(r.problems.length, 1);
    assert.match(r.problems[0].reason, /矛盾/);
    assert.match(r.problems[0].reason, /第 1 行/);
  });

  it("空文本什么都不产出，也不报错", () => {
    const r = parseFulfillText("");
    assert.deepEqual([r.entries.length, r.problems.length], [0, 0]);
  });
});

// ── 对账计划 ─────────────────────────────────────────────────

describe("对账计划", () => {
  const apps: AppLite[] = [
    { id: "a1", domain: "one.icu", status: "approved" },
    { id: "a2", domain: "two.icu", status: "fulfilling" },
    { id: "a3", domain: "done.icu", status: "fulfilled" },
    { id: "a4", domain: "lost.icu", status: "failed" },
    { id: "a5", domain: "new.icu", status: "submitted" },
  ];

  const plan = (text: string) => planBulkFulfill(parseFulfillText(text), apps);

  it("已通过 / 履约中的按结果分进成功、失败两队", () => {
    const p = plan("one.icu 成功\ntwo.icu 失败");
    assert.deepEqual(p.fulfill.map((t) => t.applicationId), ["a1"]);
    assert.deepEqual(p.fail.map((t) => t.applicationId), ["a2"]);
  });

  it("**系统里没有的域名单独列出，绝不静默丢掉**", () => {
    // 出现它多半是管理员粘错了活动或粘错了列表 ——
    // 静默丢掉的话他会以为整批都处理完了
    const p = plan("one.icu 成功\nstranger.icu 成功");
    assert.deepEqual(p.unknown, ["stranger.icu"]);
    assert.equal(p.fulfill.length, 1);
  });

  it("**同一结果粘两遍是幂等的** —— 已处理过的落进跳过队列", () => {
    const p = plan("done.icu 成功\nlost.icu 失败");
    assert.equal(p.already.length, 2);
    assert.deepEqual([p.fulfill.length, p.fail.length], [0, 0]);
  });

  it("已记成功这次说失败：冲突，要人工核实 —— 机器两边都不敢信", () => {
    const p = plan("done.icu 失败");
    assert.equal(p.conflicts.length, 1);
    assert.match(p.conflicts[0].reason, /人工核实/);
  });

  it("已记失败这次说成功：冲突 —— 状态机里失败后要重新走申请", () => {
    const p = plan("lost.icu 成功");
    assert.equal(p.conflicts.length, 1);
    assert.match(p.conflicts[0].reason, /重新提交/);
  });

  it("还没审核通过的收不下结果 —— 直接回填等于绕过审核", () => {
    const p = plan("new.icu 成功");
    assert.equal(p.conflicts.length, 1);
    assert.match(p.conflicts[0].reason, /审核/);
  });

  it("**同一域名挂着旧失败和新在途申请时，对到在途那条**", () => {
    const twice: AppLite[] = [
      { id: "old", domain: "retry.icu", status: "failed" },
      { id: "cur", domain: "retry.icu", status: "approved" },
    ];
    const p = planBulkFulfill(parseFulfillText("retry.icu 成功"), twice);
    assert.deepEqual(p.fulfill.map((t) => t.applicationId), ["cur"]);
    assert.equal(p.already.length, 0);
  });

  it("解析问题原样带进计划 —— 预览界面只看计划这一份东西", () => {
    const p = plan("？？？ 成功");
    assert.equal(p.problems.length, 1);
  });

  it("失败原因跟着进执行队列，最终会通知到申请人", () => {
    const p = plan("two.icu 失败 已被抢注");
    assert.equal(p.fail[0].note, "已被抢注");
  });
});

// ── 注册商列表导出（走真库） ─────────────────────────────────

type Queries = typeof import("@/lib/activities/queries");
type DbModule = typeof import("@/lib/db");
type SchemaModule = typeof import("@/lib/db/schema");

let queries: Queries;
let dbm: DbModule;
let schema: SchemaModule;

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  queries = await import("@/lib/activities/queries");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

describe("注册商列表导出", () => {
  beforeEach(() => {
    for (const t of [schema.activityApplications, schema.activities, schema.users]) {
      dbm.db.delete(t).run();
    }
    dbm.db
      .insert(schema.users)
      .values({ id: "alice", wxId: "wx_alice", siteNickname: "alice", status: "active" })
      .run();
    dbm.db
      .insert(schema.activities)
      .values({ id: "act1", moduleKey: "domain", title: "域名发放", status: "open", createdBy: "alice" })
      .run();
  });

  function app(id: string, status: string, key = `${id}.icu`) {
    dbm.db
      .insert(schema.activityApplications)
      .values({
        id,
        activityId: "act1",
        userId: "alice",
        status: status as "submitted",
        normalizedKey: key,
        payload: { name: id, tld: "icu" },
      })
      .run();
  }

  it("**一行一个域名，没有别的列** —— 要能直接粘进注册商的批量框", () => {
    app("aaa", "approved");
    app("bbb", "fulfilling");
    assert.equal(queries.exportRegistrarList("act1", "pending"), "aaa.icu\nbbb.icu");
  });

  it("pending 档不含已处理过的；all 档含 —— 去对总账时用", () => {
    app("aaa", "approved");
    app("bbb", "fulfilled");
    app("ccc", "failed");

    assert.equal(queries.exportRegistrarList("act1", "pending"), "aaa.icu");
    assert.equal(queries.exportRegistrarList("act1", "all"), "aaa.icu\nbbb.icu\nccc.icu");
  });

  it("**没审核过的不导出** —— 导了等于绕过审核直接注册", () => {
    app("aaa", "submitted");
    app("bbb", "waitlisted");
    assert.equal(queries.exportRegistrarList("act1", "all"), "");
  });

  it("同一域名的旧失败 + 新在途只出现一次 —— 出现两次会被注册两次", () => {
    app("old1", "failed", "retry.icu");
    app("cur1", "approved", "retry.icu");
    assert.equal(queries.exportRegistrarList("act1", "all"), "retry.icu");
  });

  it("空活动导出空串", () => {
    assert.equal(queries.exportRegistrarList("act1", "pending"), "");
  });
});

// ── 接线：写出来的东西必须真的被调到 ─────────────────────────

describe("接线", () => {
  const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

  it("**后台页面真的渲染了批量面板并传入两档导出**", () => {
    // 这个项目反复出现「声明了但没人调用」的代码 —— 这条测试锁住接线
    const page = src("app/(app)/admin/activities/page.tsx");
    assert.match(page, /<RegistrarExport/);
    assert.match(page, /<BulkFulfillPanel/);
    assert.match(page, /exportRegistrarList\(activity\.id, "pending"\)/);
    assert.match(page, /exportRegistrarList\(activity\.id, "all"\)/);
  });

  it("面板真的调了预览和提交两个 action", () => {
    const panel = src("components/admin/BulkDomainOps.tsx");
    assert.match(panel, /previewBulkFulfill\(\{ activityId, text \}\)/);
    assert.match(panel, /commitBulkFulfill\(\{ activityId, text \}\)/);
  });

  it("**剪贴板有降级路径** —— 微信内置浏览器经常拿不到 clipboard 权限", () => {
    const panel = src("components/admin/BulkDomainOps.tsx");
    assert.match(panel, /navigator\.clipboard\.writeText/);
    assert.match(panel, /execCommand\("copy"\)/);
    // 最后的兜底是那个可以全选的 textarea 本身
    assert.match(panel, /<textarea[\s\S]*?readOnly/);
  });

  it("预览只用 requireAdmin —— 它不写库，不该被预览态拦住", () => {
    const code = src("lib/activities/actions.ts");
    const preview = code.slice(
      code.indexOf("async function previewBulkFulfill"),
      code.indexOf("export interface BulkCommitResult"),
    );
    assert.match(preview, /requireAdmin\("activity\.fulfill"\)/);
    assert.doesNotMatch(preview, /requireWritableAdmin/);
  });

  it("**提交走 requireWritableAdmin，并且和单条回填走同一个 fulfillOne**", () => {
    /*
     * 批量另写一份履约逻辑的话，改名额规则时总有一份会被忘掉 ——
     * 被忘掉的那份少还一个名额，没有人会来投诉。
     */
    const code = src("lib/activities/actions.ts");
    const commit = code.slice(
      code.indexOf("async function commitBulkFulfill"),
      code.indexOf("async function transition"),
    );
    assert.match(commit, /requireWritableAdmin\("activity\.fulfill"\)/);
    assert.match(commit, /fulfillOne\(/);

    const single = code.slice(
      code.indexOf("export async function fulfillApplication"),
      code.indexOf("async function fulfillOne"),
    );
    assert.match(single, /fulfillOne\(/);
  });

  it("提交前按当前库况重算计划，而不是信客户端传回来的计划", () => {
    const code = src("lib/activities/actions.ts");
    const commit = code.slice(
      code.indexOf("async function commitBulkFulfill"),
      code.indexOf("async function transition"),
    );
    assert.match(commit, /planForActivity\(/);
  });
});
