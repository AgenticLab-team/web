import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";
import { stripComments as strip } from "./_source";

/**
 * 矩阵快照与回滚。
 *
 * ─────────────────────────────────────────
 * 这一组里最要紧的一条在「并集」那里
 * ─────────────────────────────────────────
 *
 * 回滚只遍历快照里的格子的话,会漏掉**快照之后新增的那些** ——
 * 它们在快照里不存在,于是回滚不碰它们,
 * 结果是「回滚完了,那条越权的授权还在」。
 *
 * 那是这个功能最坏的失败方式:它报告成功,而问题还在原地,
 * 于是没有人再去查第二遍。
 */

const tmp = mkdtempSync(join(tmpdir(), "al-snap-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

let dbm: typeof import("@/lib/db");
let schema: typeof import("@/lib/db/schema");
let snaps: typeof import("@/lib/rbac/matrix-snapshots");
let apply: typeof import("@/lib/rbac/matrix-apply");
let can: typeof import("@/lib/rbac/can");

const ADMIN_ROLE = "01ROLEADMIN0000000000000AA";
const MOD_ROLE = "01ROLEMOD00000000000000AA";
const U1 = "01USER1000000000000000000";

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  snaps = await import("@/lib/rbac/matrix-snapshots");
  apply = await import("@/lib/rbac/matrix-apply");
  can = await import("@/lib/rbac/can");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

const names = (id: string) => (id === ADMIN_ROLE ? "管理员" : "版主");

const change = (
  roleId: string,
  key: string,
  from: "granted" | "denied" | "none",
  to: "granted" | "denied" | "none",
) => ({ roleId, roleName: names(roleId), permissionKey: key, from, to });

beforeEach(() => {
  for (const t of [
    schema.matrixSnapshots,
    schema.auditLogs,
    schema.userRoles,
    schema.rolePermissions,
    schema.roles,
    schema.users,
  ]) {
    dbm.db.delete(t).run();
  }
  can.invalidatePermissionCache();

  dbm.db
    .insert(schema.roles)
    .values([
      { id: ADMIN_ROLE, key: "admin", name: "管理员", priority: 90 },
      { id: MOD_ROLE, key: "mod", name: "版主", priority: 70 },
    ])
    .run();
  dbm.db
    .insert(schema.rolePermissions)
    .values([
      { roleId: ADMIN_ROLE, permissionKey: "role.manage", granted: true },
      { roleId: MOD_ROLE, permissionKey: "forum.view", granted: true },
    ])
    .run();
  dbm.db
    .insert(schema.users)
    .values({ id: U1, wxId: "u1", wxNickname: "甲", status: "active" })
    .run();
  dbm.db.insert(schema.userRoles).values({ userId: U1, roleId: ADMIN_ROLE }).run();
  can.invalidatePermissionCache();
});

const take = (reason = "调整权限") =>
  snaps.takeSnapshot({ changes: [], summary: "测试", reason, actorId: U1 });

describe("快照拍的是改动之前", () => {
  it("**先拍再改** —— 反过来的话第一次编辑就没有原始状态可回", () => {
    /*
     * 而「第一次编辑」恰恰是最可能出错的那一次。
     */
    const id = take();
    apply.applyMatrixChange(
      [change(MOD_ROLE, "forum.post.delete.any", "none", "granted")],
      U1,
      "扩权",
      { gained: [], lost: [] },
    );

    const cells = snaps.readSnapshot(id)!;
    assert.equal(cells[MOD_ROLE]?.["forum.post.delete.any"], undefined, "快照里有改动之后的样子");
    assert.equal(cells[MOD_ROLE]?.["forum.view"], "granted");
  });

  it("存的是整张表，不是一条 diff", () => {
    const cells = snaps.readSnapshot(take())!;
    assert.ok(cells[ADMIN_ROLE]);
    assert.ok(cells[MOD_ROLE]);
    assert.equal(cells[ADMIN_ROLE]["role.manage"], "granted");
  });

  it("显式拒绝也存得下来", () => {
    dbm.db
      .insert(schema.rolePermissions)
      .values({ roleId: MOD_ROLE, permissionKey: "points.adjust", granted: false })
      .run();
    const cells = snaps.readSnapshot(take())!;
    assert.equal(cells[MOD_ROLE]["points.adjust"], "denied");
  });

  it("找不到的快照返回 null，不炸", () => {
    assert.equal(snaps.readSnapshot("01NOPE00000000000000000AA"), null);
  });
});

describe("**回滚要遍历并集**", () => {
  it("**快照之后新增的格子会被撤掉** —— 只看快照的话它会留在原地", () => {
    /*
     * 这是这个功能最坏的失败方式:回滚报告成功,而那条越权的授权还在,
     * 于是没有人再去查第二遍。
     */
    const id = take();
    apply.applyMatrixChange(
      [change(MOD_ROLE, "system.settings", "none", "granted")],
      U1,
      "越权授权",
      { gained: [], lost: [] },
    );

    const changes = snaps.changesToRestore(snaps.readSnapshot(id)!, apply.currentCells(), names);
    const undo = changes.find((c) => c.permissionKey === "system.settings");
    assert.ok(undo, "新增的那一格没被撤掉 —— 回滚会报告成功但问题还在");
    assert.equal(undo!.to, "none");
  });

  it("快照里有、现在被删掉的格子会被加回来", () => {
    const id = take();
    apply.applyMatrixChange([change(MOD_ROLE, "forum.view", "granted", "none")], U1, "收回", {
      gained: [],
      lost: [],
    });

    const changes = snaps.changesToRestore(snaps.readSnapshot(id)!, apply.currentCells(), names);
    const redo = changes.find((c) => c.permissionKey === "forum.view");
    assert.equal(redo?.to, "granted");
  });

  it("**快照之后新建的身份组也要处理** —— 它整个不在快照里", () => {
    const id = take();
    const NEW_ROLE = "01ROLENEW00000000000000AA";
    dbm.db
      .insert(schema.roles)
      .values({ id: NEW_ROLE, key: "new", name: "新组", priority: 50 })
      .run();
    dbm.db
      .insert(schema.rolePermissions)
      .values({ roleId: NEW_ROLE, permissionKey: "system.settings", granted: true })
      .run();

    const changes = snaps.changesToRestore(
      snaps.readSnapshot(id)!,
      apply.currentCells(),
      (rid) => (rid === NEW_ROLE ? "新组" : names(rid)),
    );
    assert.ok(
      changes.some((c) => c.roleId === NEW_ROLE && c.to === "none"),
      "新身份组上的授权被回滚漏掉了",
    );
  });

  it("没变过的话，回滚是一串空改动", () => {
    const changes = snaps.changesToRestore(snaps.readSnapshot(take())!, apply.currentCells(), names);
    assert.deepEqual(changes, []);
  });

  it("回滚之后再算一次，就没有改动了 —— 幂等", () => {
    const id = take();
    apply.applyMatrixChange(
      [change(MOD_ROLE, "system.settings", "none", "granted")],
      U1,
      "越权",
      { gained: [], lost: [] },
    );

    const first = snaps.changesToRestore(snaps.readSnapshot(id)!, apply.currentCells(), names);
    apply.applyMatrixChange(first, U1, "回滚", { gained: [], lost: [] });

    const second = snaps.changesToRestore(snaps.readSnapshot(id)!, apply.currentCells(), names);
    assert.deepEqual(second, [], "回滚一次不够，说明还原不完整");
  });

  it("排过序 —— 回滚预览的顺序要稳定", () => {
    const id = take();
    apply.applyMatrixChange(
      [
        change(MOD_ROLE, "points.adjust", "none", "granted"),
        change(ADMIN_ROLE, "shop.manage", "none", "granted"),
      ],
      U1,
      "两处",
      { gained: [], lost: [] },
    );
    const a = snaps.changesToRestore(snaps.readSnapshot(id)!, apply.currentCells(), names);
    const b = snaps.changesToRestore(snaps.readSnapshot(id)!, apply.currentCells(), names);
    assert.deepEqual(a, b);
  });
});

describe("列表", () => {
  it("最新的排最前 —— 出事之后要回的多半是刚才那一张", () => {
    snaps.takeSnapshot({ changes: [], summary: "s1", reason: "第一次", actorId: U1 });
    snaps.takeSnapshot({ changes: [], summary: "s2", reason: "第二次", actorId: U1 });
    const list = snaps.listSnapshots();
    assert.equal(list[0].reason, "第二次");
  });

  it("带上是谁拍的", () => {
    take();
    assert.equal(snaps.listSnapshots()[0].takenByName, "甲");
  });

  it("人被删了也不炸", () => {
    take();
    dbm.db.delete(schema.users).where(eq(schema.users.id, U1)).run();
    assert.equal(snaps.listSnapshots()[0].takenByName, "（已删除）");
  });

  it("**回滚拍的快照标着 isRollback** —— 事后要分得出哪些是补救", () => {
    snaps.takeSnapshot({ changes: [], summary: "s", reason: "回滚", actorId: U1, isRollback: true });
    assert.equal(snaps.listSnapshots()[0].isRollback, true);
  });

  it("记下当时那次改动有多少格、影响面是什么", () => {
    snaps.takeSnapshot({
      changes: [change(MOD_ROLE, "forum.view", "granted", "none")],
      summary: "失去 1 项，影响 1 人",
      reason: "收回",
      actorId: U1,
    });
    const row = snaps.listSnapshots()[0];
    assert.equal(row.changeCount, 1);
    assert.match(row.changeSummary, /影响 1 人/);
  });
});

describe("只留最近的若干张", () => {
  it("超出上限的会被清掉", () => {
    for (let i = 0; i < snaps.SNAPSHOT_RETENTION + 5; i++) {
      dbm.db
        .insert(schema.matrixSnapshots)
        .values({
          cells: "{}",
          changeCount: 1,
          changeSummary: "s",
          reason: `第 ${i} 次`,
          takenBy: U1,
          createdAt: 1_000_000 + i,
        })
        .run();
    }
    take();

    const all = dbm.db.select().from(schema.matrixSnapshots).all();
    assert.ok(all.length <= snaps.SNAPSHOT_RETENTION, `留了 ${all.length} 张`);
  });

  it("**留下的是最近的那些**，不是最早的", () => {
    for (let i = 0; i < snaps.SNAPSHOT_RETENTION + 5; i++) {
      dbm.db
        .insert(schema.matrixSnapshots)
        .values({
          cells: "{}",
          changeCount: 1,
          changeSummary: "s",
          reason: `第 ${i} 次`,
          takenBy: U1,
          createdAt: 1_000_000 + i,
        })
        .run();
    }
    take();

    const reasons = dbm.db.select().from(schema.matrixSnapshots).all().map((r) => r.reason);
    assert.equal(reasons.includes("第 0 次"), false, "把最早的留下了，最近的删了");
  });
});

describe("接线", () => {
  const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
  
  it("**保存前会拍快照** —— 不拍的话这个功能等于不存在", () => {
    const code = strip(src("lib/rbac/matrix-actions.ts"));
    const evaluate = code.slice(code.indexOf("function evaluate"));
    const snapAt = evaluate.indexOf("takeSnapshot(");
    const applyAt = evaluate.indexOf("applyMatrixChange(");
    assert.ok(snapAt > 0, "保存路径上没有拍快照");
    assert.ok(snapAt < applyAt, "先改了再拍 —— 那拍到的是改动之后的样子");
  });

  it("**回滚走同一条护栏** —— 否则它是一条绕开提权检查的近路", () => {
    /*
     * 快照里可能有一项我现在没有的权限。
     * 不查护栏的话,「回滚」就成了把它拿回来的办法。
     */
    const code = strip(src("lib/rbac/matrix-actions.ts"));
    const fn = code.slice(code.indexOf("function rollbackMatrix"), code.indexOf("function previewRollback"));
    assert.match(fn, /evaluate\(/, "回滚绕开了 evaluate，也就绕开了全部护栏");
    assert.doesNotMatch(fn, /applyMatrixChange\(/, "回滚直接落库了，没走护栏");
  });

  it("回滚自己也会被拍快照 —— 历史里不能出现空洞", () => {
    /*
     * 设置那边的原话:「回滚本身也是一次变更,同样进历史 ——
     * 历史里不能出现空洞,否则事后复盘会看到值凭空变了」。
     */
    const code = strip(src("lib/rbac/matrix-actions.ts"));
    const evaluate = code.slice(code.indexOf("function evaluate"), code.indexOf("function rollbackMatrix"));
    assert.match(evaluate, /isRollback/, "evaluate 不认识 isRollback，那回滚拍的快照标不出来");
    assert.match(evaluate, /takeSnapshot\(/);
    assert.match(evaluate, /isRollback,/, "isRollback 没传进 takeSnapshot");
  });

  it("回滚要 requireWritableAdmin —— 预览态下不能真的回滚", () => {
    const code = strip(src("lib/rbac/matrix-actions.ts"));
    const fn = code.slice(code.indexOf("function rollbackMatrix"), code.indexOf("function previewRollback"));
    assert.match(fn, /requireWritableAdmin/);
  });
});
