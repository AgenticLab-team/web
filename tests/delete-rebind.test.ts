import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

/**
 * 注销之后再回来。
 *
 * ─────────────────────────────────────────
 * 「退出」不能变成「永久驱逐」
 * ─────────────────────────────────────────
 *
 * 注销把 `users.wx_id` 清空了 —— 那是为了断掉
 * `users.wx_id → people` 这条 join，否则旧帖子照样显示昵称头像。
 *
 * 但它有个下游：绑定流程正是按 `wx_id` 找账号的。
 * 清空之后重新绑定会走「找不到 → 新建」那条路，也就是拿到一个
 * **全新的账号**。这是想要的语义 —— 但必须真的跑得通，
 * 否则一个人注销之后就再也回不来了，而这个站只有群成员能登录。
 *
 * ─────────────────────────────────────────
 * 而「全新的账号」正好打开了一个洞
 * ─────────────────────────────────────────
 *
 * 邀请那条「一个人只能被邀请一次」一直只按 user_id 判。
 * 在没有注销功能的时候，那等价于按人判 —— 做出注销之后就不等价了。
 *
 * 那条规则**自己的注释**写着：「不限制的话，注销重注册就能反复
 * 给同一个邀请人送奖励」。也就是说，注销这个功能恰好把它描述的
 * 那条路打开了。
 */

const TMP = mkdtempSync(join(tmpdir(), "al-rebind-"));
process.env.DB_PATH = join(TMP, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";
process.env.SITE_URL = "https://example.test";

describe("注销之后重新绑定", async () => {
  const dbm = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  const { deleteAccount } = await import("@/lib/users/delete");
  const { isAlreadyInvited } = await import("@/lib/invites/queries");
  const { eq } = await import("drizzle-orm");

  after(() => rmSync(TMP, { recursive: true, force: true }));

  const WX = "wxid_comeback";

  const reset = () => {
    dbm.db.delete(schema.inviteUses).run();
    dbm.db.delete(schema.users).run();
  };

  /** 模拟绑定：按 wx_id 找，找不到就新建 —— 和 lib/auth/bind.ts 同一条路 */
  function bind(wxId: string): { id: string; isNew: boolean } {
    const existing = dbm.db.select().from(schema.users).where(eq(schema.users.wxId, wxId)).get();
    if (existing) return { id: existing.id, isNew: false };
    const created = dbm.db
      .insert(schema.users)
      .values({ wxId, wxNickname: "回来的人", kind: "member", status: "active" })
      .returning({ id: schema.users.id })
      .get();
    return { id: created.id, isNew: true };
  }

  it("**注销之后能重新绑定** —— 否则注销就成了永久驱逐", () => {
    reset();
    const first = bind(WX);
    deleteAccount(first.id, { by: first.id, reason: "测试" });

    const second = bind(WX);
    assert.equal(second.isNew, true, "重新绑定没能新建账号 —— 人回不来了");
    assert.notEqual(second.id, first.id, "复用了注销掉的那个账号");
  });

  it("**旧账号仍是注销状态**，没有被复活", () => {
    reset();
    const first = bind(WX);
    deleteAccount(first.id, { by: first.id, reason: "测试" });
    bind(WX);

    const old = dbm.db.select().from(schema.users).where(eq(schema.users.id, first.id)).get()!;
    assert.equal(old.status, "deleted");
    assert.equal(old.wxId, null);
    assert.equal(old.priorWxId, WX);
  });

  it("**连着注销两次也不会撞唯一索引** —— wx_id 清空后是 NULL", () => {
    /*
     * users.wx_id 上有唯一索引。两个注销掉的账号 wx_id 都是 NULL，
     * SQLite 的唯一索引允许多个 NULL —— 但这一条不该靠「我记得是这样」，
     * 撞上了就是第二个人注销时直接报错。
     */
    reset();
    const a = bind(WX);
    deleteAccount(a.id, { by: a.id, reason: "第一次" });
    const b = bind(WX);
    assert.doesNotThrow(() => deleteAccount(b.id, { by: b.id, reason: "第二次" }));

    const deleted = dbm.db.select().from(schema.users).all().filter((u) => u.status === "deleted");
    assert.equal(deleted.length, 2);
  });

  it("**prior_wx_id 是判定用的，不参与展示** —— 它是那条 join 断掉之后唯一的线索", () => {
    /*
     * 一度写过一个 `hadAccountBefore(wxId)` 的小函数，
     * 结果**除了测试没有任何地方调用它** —— 邀请那边要的是
     * 「具体是哪几个旧账号」，一个布尔值不够用。
     *
     * 于是它成了我自己造的一个死开关：读起来像有人在守着，
     * 实际什么都没守。删掉了。真正的判定在 invites/queries.ts 里。
     */
    reset();
    const first = bind(WX);
    deleteAccount(first.id, { by: first.id, reason: "测试" });
    const old = dbm.db.select().from(schema.users).where(eq(schema.users.id, first.id)).get()!;
    assert.equal(old.priorWxId, WX);
    assert.equal(old.wxId, null, "展示那条 join 必须是断的");
  });

  describe("**注销重绑不能把一次性的邀请奖励再领一遍**", () => {
    const inviteOnce = (userId: string) =>
      dbm.db
        .insert(schema.inviteUses)
        .values({
          id: `use_${userId}`,
          inviteId: "inv1",
          inviterId: "u_inviter",
          invitedUserId: userId,
        })
        .run();

    it("没被邀请过的人，判定是「还没有」", () => {
      reset();
      const me = bind(WX);
      assert.equal(isAlreadyInvited(me.id), false);
    });

    it("被邀请过之后，判定是「已经有了」", () => {
      reset();
      const me = bind(WX);
      inviteOnce(me.id);
      assert.equal(isAlreadyInvited(me.id), true);
    });

    it("**注销重绑之后，新账号照样算「已经被邀请过」**", () => {
      /*
       * 这是整条链上最容易漏的一处：新账号在 invite_uses 里
       * 一条记录都没有，只按 user_id 查的话它干干净净 ——
       * 于是同一个人可以反复注销重绑，每次都给邀请人送一份奖励。
       */
      reset();
      const first = bind(WX);
      inviteOnce(first.id);
      deleteAccount(first.id, { by: first.id, reason: "测试" });

      const second = bind(WX);
      assert.equal(
        isAlreadyInvited(second.id),
        true,
        "注销重绑之后又能被邀请一次 —— 邀请奖励可以无限刷",
      );
    });

    it("**反复注销重绑也堵得住**", () => {
      reset();
      const first = bind(WX);
      inviteOnce(first.id);
      deleteAccount(first.id, { by: first.id, reason: "1" });
      const second = bind(WX);
      deleteAccount(second.id, { by: second.id, reason: "2" });
      const third = bind(WX);
      assert.equal(isAlreadyInvited(third.id), true);
    });

    it("**别人不受影响** —— 另一个微信号照样能被邀请", () => {
      reset();
      const first = bind(WX);
      inviteOnce(first.id);
      deleteAccount(first.id, { by: first.id, reason: "测试" });
      bind(WX);

      const other = bind("wxid_someone_else");
      assert.equal(isAlreadyInvited(other.id), false, "把无关的人也当成邀请过了");
    });
  });
});
