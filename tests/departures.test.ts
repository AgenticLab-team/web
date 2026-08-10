import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { readCode, readSource } from "./_source";

/**
 * 离开的人。
 *
 * ─────────────────────────────────────────
 * 注销之后这些人从后台整个消失了
 * ─────────────────────────────────────────
 *
 * `listUsers` 的第一个条件就是 `isNull(deleted_at)` ——
 * 注销掉的账号不在任何列表里、也不进状态分布。
 *
 * 而注销表单上明明白白写着「想说点什么吗？**只有管理员看得到**」。
 * 收了理由却没有任何地方读得到，那句话就是假的 ——
 * 而且这是我自己上一轮写下的。
 *
 * ─────────────────────────────────────────
 * 给的是理由，不是身份
 * ─────────────────────────────────────────
 *
 * 注销把昵称、头像、wx_id 全清空了，就是为了不再被认出来。
 * 在这一页顺着 `prior_wx_id` 反查回昵称，等于把刚做掉的匿名化
 * 又拆开 —— 而且是在一个每天都有人打开的页面上。
 *
 * 真需要知道是谁（合规、纠纷）去审计日志：那里留着 targetLabel，
 * 而查审计这件事本身也会被审计。
 * **顺手看得到的和特意去查的，不该是同一个门槛。**
 */

const TMP = mkdtempSync(join(tmpdir(), "al-dep-"));
process.env.DB_PATH = join(TMP, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";
process.env.SITE_URL = "https://example.test";

describe("查询", async () => {
  const dbm = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  const { listDepartures, departureCount } = await import("@/lib/admin/users");
  const { deleteAccount } = await import("@/lib/users/delete");

  after(() => rmSync(TMP, { recursive: true, force: true }));

  let seq = 0;
  function user(wxId: string) {
    const id = `u${++seq}`;
    dbm.db
      .insert(schema.users)
      .values({ id, wxId, siteNickname: `昵称${seq}`, status: "active" })
      .run();
    return id;
  }

  const reset = () => dbm.db.delete(schema.users).run();

  it("没人走的时候是空的", () => {
    reset();
    user("wx_a");
    assert.deepEqual(listDepartures(), []);
  });

  it("**自助注销和管理员操作分得开**", () => {
    /*
     * 「有人自己走了」和「有人被清掉了」是两件完全不同的事，
     * 混在一起的话这一段就没有意义了。
     */
    reset();
    const self = user("wx_self");
    const kicked = user("wx_kicked");
    deleteAccount(self, { by: self, reason: "不常用了" });
    deleteAccount(kicked, { by: "u_admin", reason: "违规清理" });

    const list = listDepartures();
    assert.equal(list.length, 2);
    assert.equal(list.find((d) => d.id === self)!.bySelf, true);
    assert.equal(list.find((d) => d.id === kicked)!.bySelf, false);
  });

  it("**留的话读得到** —— 表单上承诺过管理员看得到", () => {
    reset();
    const id = user("wx_a");
    deleteAccount(id, { by: id, reason: "隐私顾虑，先退了" });
    assert.equal(listDepartures()[0].reason, "隐私顾虑，先退了");
  });

  it("没留话的是 null，不是空字符串", () => {
    // 界面靠它区分「没说」和「说了但是空的」
    reset();
    const id = user("wx_a");
    deleteAccount(id, { by: id, reason: "   " });
    assert.equal(listDepartures()[0].reason, null);
  });

  it("最近的排在前面", () => {
    reset();
    const a = user("wx_a");
    const b = user("wx_b");
    deleteAccount(a, { by: a, reason: "先走的" });
    deleteAccount(b, { by: b, reason: "后走的" });
    const list = listDepartures();
    assert.equal(list[0].reason, "后走的");
  });

  it("**没走的人不在里面**", () => {
    reset();
    user("wx_still_here");
    const gone = user("wx_gone");
    deleteAccount(gone, { by: gone, reason: "走了" });
    assert.deepEqual(listDepartures().map((d) => d.id), [gone]);
  });

  it("最近 N 天走了几个", () => {
    reset();
    const a = user("wx_a");
    deleteAccount(a, { by: a, reason: "x" });
    assert.equal(departureCount(Date.now() - 86_400_000), 1);
    assert.equal(departureCount(Date.now() + 1000), 0);
  });
});

describe("**只给理由，不给身份**", () => {
  const query = readCode("lib/admin/users.ts");
  const page = readCode("app/(app)/admin/users/page.tsx");
  const pageText = readSource("app/(app)/admin/users/page.tsx");

  it("**查询里不碰 prior_wx_id**", () => {
    /*
     * 顺着它反查回昵称的话，等于把刚做掉的匿名化又拆开 ——
     * 而且是在一个每天都有人打开的页面上。
     */
    const start = query.indexOf("export function listDepartures");
    const end = query.indexOf("export function departureCount");
    const body = query.slice(start, end);
    assert.ok(start > 0 && end > start);
    assert.equal(body.includes("priorWxId"), false, "离开列表里反查了 wx_id");
    assert.equal(body.includes("people"), false, "join 回了群成员档案");
  });

  it("**返回的字段里没有任何能认出人的东西**", () => {
    const start = query.indexOf("export interface Departure");
    const end = query.indexOf("export function listDepartures");
    const shape = query.slice(start, end);
    for (const leak of ["wxId", "nickname", "avatar", "name"]) {
      assert.equal(shape.includes(leak), false, `Departure 里带了 ${leak}`);
    }
  });

  it("**页面上说明了为什么不显示是谁**", () => {
    // 不说的话，看的人会以为是数据坏了，然后去「修」它
    assert.match(pageText, /这里不显示是谁/);
  });

  it("**指出确有必要时去哪查** —— 不是一句「查不到」了事", () => {
    assert.match(page, /\/admin\/audit\?action=user\.delete/);
  });

  it("**一个人都没走的时候整段不渲染**", () => {
    // 常驻一个空的「离开的人」，每天看一眼都像在提醒有人要走
    assert.match(page, /departures\.length > 0 && \(/);
  });
});
