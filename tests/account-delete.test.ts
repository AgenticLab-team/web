import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

/**
 * 真的执行注销。
 *
 * ─────────────────────────────────────────
 * 这一档必须跑真库
 * ─────────────────────────────────────────
 *
 * 执行器是按登记表拼出来的**裸 SQL**（表名列名都是字符串）——
 * tsc 一个字都检查不到。写错一个列名的表现是那张表根本没被清，
 * 而且不报错：注销跑完了，痕迹还在。
 *
 * 事实上第一版就写错了两个（`avatar`、`meta` 之外还有 `username`），
 * 靠这一档跑起来才发现。
 *
 * ─────────────────────────────────────────
 * 最要紧的一条：抹名字要真的抹得掉
 * ─────────────────────────────────────────
 *
 * 帖子作者名是顺着 `users.wx_id → people` 查出来的。
 * 只把 `site_nickname` 清空、留着 `wx_id` 的话，
 * 旧帖子照样显示昵称、头像和能点进主页的链接 ——
 * 「抹掉作者」看起来做了，实际什么都没发生。
 */

const TMP = mkdtempSync(join(tmpdir(), "al-del-"));
process.env.DB_PATH = join(TMP, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";
process.env.SITE_URL = "https://example.test";

describe("注销", async () => {
  const dbm = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  const { deleteAccount } = await import("@/lib/users/delete");
  const { DELETION_PLAN } = await import("@/lib/users/deletion-plan");
  const { sql, eq } = await import("drizzle-orm");

  after(() => rmSync(TMP, { recursive: true, force: true }));

  const ME = "u_me";
  const OTHER = "u_other";
  const MY_WX = "wxid_me";

  function seed() {
    for (const t of [
      schema.users,
      schema.sessions,
      schema.posts,
      schema.replies,
      schema.people,
      schema.pushSubscriptions,
      schema.keywordSubs,
      schema.keywordHits,
      schema.auditLogs,
      schema.pointsLedger,
      schema.checkins,
      schema.userRoles,
    ]) {
      dbm.db.delete(t).run();
    }

    dbm.db
      .insert(schema.users)
      .values([
        {
          id: ME,
          wxId: MY_WX,
          siteNickname: "我的站内昵称",
          wxNickname: "我的微信昵称",
          wxAvatarUrl: "https://x/me.jpg",
          bio: "我的简介",
          status: "active",
        },
        { id: OTHER, wxId: "wxid_other", siteNickname: "别人", status: "active" },
      ])
      .run();

    // 群成员档案（wx 那一侧，注销后必须还在）
    dbm.db
      .insert(schema.people)
      .values({ wxId: MY_WX, displayName: "我的微信昵称", avatarUrl: "https://x/me.jpg" })
      .run();

    dbm.db.insert(schema.sessions).values({ id: "s1", userId: ME, tokenHash: "t1", expiresAt: Date.now() + 1e6 }).run();
    dbm.db.insert(schema.pushSubscriptions).values({ id: "p1", userId: ME, endpoint: "e", p256dh: "a", auth: "b" }).run();
    dbm.db.insert(schema.keywordSubs).values({ id: "k1", userId: ME, keyword: "RAG", keywordKey: "rag" }).run();
    dbm.db.insert(schema.keywordHits).values({ id: "h1", subId: "k1", messageId: "m1", convId: "g", hitAt: Date.now() }).run();
    dbm.db.insert(schema.checkins).values({ id: "c1", userId: ME, date: "2026-08-01", pointsAwarded: 5, basePoints: 5 }).run();
    dbm.db.insert(schema.userRoles).values({ id: "r1", userId: ME, roleId: "admin" }).run();
    dbm.db.insert(schema.pointsLedger).values({ id: "l1", userId: ME, delta: 5, reason: "checkin", balanceAfter: 5 }).run();
    dbm.db.insert(schema.auditLogs).values({ id: "a1", actorId: ME, action: "test", targetType: "user", targetId: "x" }).run();

    dbm.db
      .insert(schema.posts)
      .values({
        id: "post1",
        boardId: "b",
        authorId: ME,
        title: "我发的帖",
        content: "正文",
        contentHtml: "<p>正文</p>",
      })
      .run();
    dbm.db
      .insert(schema.replies)
      .values({ id: "rep1", postId: "post1", authorId: OTHER, floor: 1, content: "别人的回复", contentHtml: "<p>x</p>" })
      .run();
  }

  const run = () => deleteAccount(ME, { by: ME, reason: "自助注销" });
  const one = <T>(q: string): T => dbm.db.all<T>(sql.raw(q))[0];

  describe("**该删的删干净**", () => {
    it("会话没了 —— 否则注销之后旧 cookie 还能进来", () => {
      seed();
      run();
      assert.equal(one<{ c: number }>(`select count(*) c from sessions`).c, 0);
    });

    it("推送订阅没了 —— 账号注销了设备还在响是最刺眼的残留", () => {
      seed();
      run();
      assert.equal(one<{ c: number }>(`select count(*) c from push_subscriptions`).c, 0);
    });

    it("**角色没了** —— 权限留着是最危险的一种残留", () => {
      seed();
      run();
      assert.equal(one<{ c: number }>(`select count(*) c from user_roles`).c, 0);
    });

    it("打卡记录没了", () => {
      seed();
      run();
      assert.equal(one<{ c: number }>(`select count(*) c from checkins`).c, 0);
    });

    it("**间接挂靠的也清掉** —— 雷达命中挂在订阅下面，没有 user_id", () => {
      /*
       * 顺着 keyword_subs 删。不处理的话订阅没了、命中还在，
       * 成了永远找不到主人也清不掉的孤儿。
       */
      seed();
      run();
      assert.equal(one<{ c: number }>(`select count(*) c from keyword_subs`).c, 0);
      assert.equal(one<{ c: number }>(`select count(*) c from keyword_hits`).c, 0, "留下了孤儿命中");
    });

    it("**登记表里每一张 purge 表都真的被执行到了**", () => {
      /*
       * 这一条防的是列名写错：裸 SQL 里写错一个列名，
       * 那张表根本没被清，而且不报错。
       *
       * 逐张跑一遍 DELETE，看会不会抛「no such column / no such table」。
       */
      seed();
      const bad: string[] = [];
      for (const plan of DELETION_PLAN) {
        if (plan.disposition !== "purge") continue;
        const col = plan.table === "keyword_hits" ? "sub_id" : "user_id";
        try {
          dbm.db.all(sql.raw(`select count(*) from ${plan.table} where ${col} = ''`));
        } catch (e) {
          bad.push(`${plan.table}.${col}：${e instanceof Error ? e.message : e}`);
        }
      }
      assert.deepEqual(bad, [], "这些表的列名对不上，注销时会静默跳过");
    });
  });

  describe("**该留的一个都不许少**", () => {
    it("审计日志还在 —— 能被当事人抹掉的审计不是审计", () => {
      seed();
      run();
      assert.equal(one<{ c: number }>(`select count(*) c from audit_logs`).c, 1);
    });

    it("积分流水还在 —— 抹掉一个人的流水，全站总额就对不上了", () => {
      seed();
      run();
      assert.equal(one<{ c: number }>(`select count(*) c from points_ledger`).c, 1);
    });

    it("**群成员档案还在** —— 那是群的记录，不是这个站的", () => {
      seed();
      run();
      assert.equal(one<{ c: number }>(`select count(*) c from people`).c, 1);
    });

    it("**别人的回复还在** —— 删帖会毁掉别人的对话", () => {
      seed();
      run();
      assert.equal(one<{ c: number }>(`select count(*) c from forum_replies`).c, 1);
    });
  });

  describe("**抹名字要真的抹得掉**", () => {
    it("帖子正文留着，作者置空", () => {
      seed();
      const result = run();
      assert.equal(result.anonymized.posts, 1);
      const post = one<{ author_id: string; title: string }>(
        `select author_id, title from forum_posts where id = 'post1'`,
      );
      assert.equal(post.title, "我发的帖", "正文被删了 —— 别人的回复会变成自言自语");
      assert.equal(post.author_id, "", "作者没被抹掉");
    });

    it("**wx_id 必须清空** —— 留着的话昵称头像会顺着 people 全回来", () => {
      /*
       * 这是整个注销里最容易做错、也最难发现的一处：
       * site_nickname 清了看起来就抹干净了，而作者名其实是走
       * `users.wx_id → people.display_name` 查出来的。
       */
      seed();
      run();
      const row = one<{ wx_id: string | null; prior_wx_id: string | null }>(
        `select wx_id, prior_wx_id from users where id = '${ME}'`,
      );
      assert.equal(row.wx_id, null, "wx_id 还在，旧帖子照样显示昵称和头像");
      assert.equal(row.prior_wx_id, MY_WX, "没留下判定用的副本");
    });

    it("**能认出是谁的字段全部清空**", () => {
      seed();
      run();
      const row = one<Record<string, unknown>>(
        `select site_nickname, wx_nickname, wx_avatar_url, bio, username, email, phone from users where id = '${ME}'`,
      );
      for (const [k, v] of Object.entries(row)) {
        assert.equal(v, null, `${k} 没清掉 —— 它能认出这是谁`);
      }
    });

    it("**账号那一行留着壳**，不是删行", () => {
      /*
       * 删行的话，audit_logs / points_ledger 里的 user_id
       * 全成了指向虚空的外键 —— 翻出来是一串查不到人的 id。
       */
      seed();
      run();
      const row = one<{ c: number; status: string }>(
        `select count(*) c, status from users where id = '${ME}'`,
      );
      assert.equal(row.c, 1, "行被删了，审计里的引用会指向虚空");
      assert.equal(row.status, "deleted");
    });

    it("记下了是谁、什么时候、为什么", () => {
      seed();
      run();
      const row = one<{ deleted_at: number; deleted_by: string; delete_reason: string }>(
        `select deleted_at, deleted_by, delete_reason from users where id = '${ME}'`,
      );
      assert.ok(row.deleted_at > 0);
      assert.equal(row.deleted_by, ME);
      assert.equal(row.delete_reason, "自助注销");
    });
  });

  describe("**别人的东西一个字都不能动**", () => {
    it("另一个账号完好", () => {
      seed();
      run();
      const other = dbm.db.select().from(schema.users).where(eq(schema.users.id, OTHER)).get()!;
      assert.equal(other.status, "active");
      assert.equal(other.wxId, "wxid_other");
      assert.equal(other.siteNickname, "别人");
    });
  });

  describe("**注销重绑不能绕过一次性规则**", () => {
    it("prior_wx_id 留下了，一次性规则才认得出这是同一个人", () => {
      /*
       * 邀请那条「一个人只能被邀请一次」是按 user_id 判的，
       * 而重绑会拿到新的 user_id —— 没有 prior_wx_id 的话，
       * 注销就成了反复领邀请奖励的通道。
       *
       * 真正的判定与完整的重绑链路在 tests/delete-rebind.test.ts。
       */
      seed();
      run();
      const row = one<{ prior_wx_id: string | null }>(
        `select prior_wx_id from users where id = '${ME}'`,
      );
      assert.equal(row.prior_wx_id, MY_WX);
    });
  });

  describe("**要么全做完，要么一点没做**", () => {
    it("账号不存在时直接抛，不留半截", () => {
      seed();
      assert.throws(() => deleteAccount("u_nobody", { by: "x", reason: "y" }));
      // 别人的会话不能因为一次失败的注销被清掉
      assert.equal(one<{ c: number }>(`select count(*) c from sessions`).c, 1);
    });
  });
});
