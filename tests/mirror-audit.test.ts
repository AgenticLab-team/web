import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

/**
 * 镜像完整性对账。
 *
 * ─────────────────────────────────────────
 * 「归档缺了一段」有两种原因，要做的事完全相反
 * ─────────────────────────────────────────
 *
 * 一种是**本地漏了**：同步断过、游标跳过去了 —— 能补，
 * 而且必须补，因为上游随时可能清掉历史。
 *
 * 另一种是**上游本来就没有**：那几天机器人没在采集 —— 补不了。
 *
 * 两者在站里长得一模一样：按天回看都是空的，页面都只会说
 * 「这天没有消息」。这个对账是唯一能分清的东西。
 *
 * 线上第一次跑出来：11,631 = 11,631，逐群一条不差；
 * 而 2026-07-15 ~ 07-29 那 15 天上游的 total 也是 0 ——
 * 所以那段是上游自己的空白。
 */

const TMP = mkdtempSync(join(tmpdir(), "al-mirror-"));
process.env.DB_PATH = join(TMP, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";
process.env.SITE_URL = "https://example.test";

describe("对账", async () => {
  const dbm = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  const { auditMirror, classify } = await import("@/lib/admin/mirror-audit");

  after(() => rmSync(TMP, { recursive: true, force: true }));

  let seq = 0;
  function group(convId: string, localMessages: number, syncEnabled = true) {
    dbm.db
      .insert(schema.groups)
      .values({ convId, name: `群-${convId}`, isGroup: true, syncEnabled })
      .run();
    for (let i = 0; i < localMessages; i++) {
      dbm.db
        .insert(schema.messages)
        .values({
          id: `m${++seq}`,
          convId,
          senderWxId: "wx_a",
          type: "text",
          content: "内容",
          length: 10,
          ts: Date.UTC(2026, 7, 1),
        })
        .run();
    }
  }

  const reset = () => {
    dbm.db.delete(schema.messages).run();
    dbm.db.delete(schema.groups).run();
  };

  describe("判定一行", () => {
    it("一致 = ok", () => {
      assert.equal(classify(100, 100), "ok");
    });

    it("**本地少了 = behind** —— 这是唯一要报的方向", () => {
      assert.equal(classify(90, 100), "behind");
    });

    it("**本地多了不是错**", () => {
      /*
       * 上游会裁剪历史，而本地是镜像 —— 留着上游已清掉的老消息
       * 正是这个站存在的理由之一。标成红色的话，上游每裁剪一次
       * 这一页就全红，然后没有人会再看它。
       */
      assert.equal(classify(120, 100), "ahead");
    });

    it("**问不到 ≠ 0**", () => {
      assert.equal(classify(100, null), "unknown");
    });
  });

  describe("整体", () => {
    it("逐群比对，一致时全绿", async () => {
      reset();
      group("a@chatroom", 10);
      group("b@chatroom", 5);
      const audit = await auditMirror(async (c) => (c === "a@chatroom" ? 10 : 5));
      assert.equal(audit.behind, 0);
      assert.equal(audit.unknown, 0);
      assert.deepEqual(audit.rows.map((r) => r.status), ["ok", "ok"]);
      assert.deepEqual(audit.rows.map((r) => r.delta), [0, 0]);
    });

    it("**本地少的那个群被点出来**", async () => {
      reset();
      group("a@chatroom", 10);
      group("b@chatroom", 5);
      const audit = await auditMirror(async (c) => (c === "b@chatroom" ? 500 : 10));
      assert.equal(audit.behind, 1);
      const b = audit.rows.find((r) => r.convId === "b@chatroom")!;
      assert.equal(b.status, "behind");
      assert.equal(b.delta, 495);
    });

    it("**上游挂掉时不报「一切正常」**", async () => {
      /*
       * 这是这一页最坏的形态：把「问不到」当成 0，
       * 于是每个群都变成「本地比上游多」—— 一切正常，
       * 而实际上什么都没对上。
       */
      reset();
      group("a@chatroom", 10);
      const audit = await auditMirror(async () => {
        throw new Error("隧道断了");
      });
      assert.equal(audit.unknown, 1);
      assert.equal(audit.behind, 0);
      assert.equal(audit.rows[0].upstream, null);
      assert.equal(audit.rows[0].delta, null);
      assert.equal(audit.rows[0].status, "unknown");
    });

    it("**一个群问不到，不影响其余的群**", async () => {
      reset();
      group("a@chatroom", 10);
      group("b@chatroom", 5);
      const audit = await auditMirror(async (c) => {
        if (c === "a@chatroom") throw new Error("超时");
        return 5;
      });
      assert.equal(audit.unknown, 1);
      assert.equal(audit.rows.find((r) => r.convId === "b@chatroom")!.status, "ok");
    });

    it("**没接入的群不参加对账**", async () => {
      reset();
      group("a@chatroom", 10);
      group("off@chatroom", 3, false);
      const audit = await auditMirror(async () => 10);
      assert.deepEqual(audit.rows.map((r) => r.convId), ["a@chatroom"]);
    });

    it("一条消息都没有的群也算得出来", async () => {
      reset();
      group("empty@chatroom", 0);
      const audit = await auditMirror(async () => 0);
      assert.equal(audit.rows[0].local, 0);
      assert.equal(audit.rows[0].status, "ok");
    });

    it("**空群但上游有数据 = 本地漏了整个群**", async () => {
      reset();
      group("empty@chatroom", 0);
      const audit = await auditMirror(async () => 800);
      assert.equal(audit.rows[0].status, "behind");
      assert.equal(audit.rows[0].delta, 800);
    });
  });
});

describe("接线", () => {
  const lib = readFileSync(
    new URL("../src/lib/admin/mirror-audit.ts", import.meta.url),
    "utf8",
  );
  const page = readFileSync(
    new URL("../src/app/(app)/admin/community/page.tsx", import.meta.url),
    "utf8",
  );
  const action = readFileSync(
    new URL("../src/lib/admin/mirror-actions.ts", import.meta.url),
    "utf8",
  );

  it("**不在页面渲染时自动跑** —— 那会让后台每打开一次就打 12 个上游请求", () => {
    /*
     * 挂在渲染里还有两个更糟的后果：上游慢一点整页跟着卡
     * （而这一页别的数字全部来自本地，本来是瞬间的）；
     * 上游挂掉时这一页连带挂掉 —— 恰恰是最需要看它的时候。
     */
    assert.equal(page.includes("auditMirror("), false, "页面在渲染时直接跑对账了");
    assert.match(page, /<MirrorAudit \/>/);
  });

  it("**结果不落库** —— 存下来的「上次对账通过」会变成谎话", () => {
    assert.equal(lib.includes("insert("), false, "对账结果被存下来了");
  });

  it("**动作要判权限**", () => {
    assert.match(action, /requireAdmin\(\["group\.manage", "group\.stats\.read"\]\)/);
  });

  it("**整体失败要如实报**，不能返回一份空对账", () => {
    assert.match(action, /ok: false/);
  });

  it("**页面不再说缺口「多半是回填没补到」** —— 那个判断已经被证伪", () => {
    /*
     * 上游对账实测：缺口那 15 天上游 total 也是 0，
     * 而全量 11,631 = 11,631 逐群一条不差。
     * 也就是说那段是上游自己的空白，补不回来 ——
     * 写成「回填没补到」会让人去跑一个跑不出结果的同步。
     */
    assert.equal(page.includes("多半是回填没补到"), false);
    assert.match(page, /上游本来就没有/);
  });
});
