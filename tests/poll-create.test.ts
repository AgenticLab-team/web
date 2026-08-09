import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import {
  MAX_OPTIONS,
  MAX_OPTION_CHARS,
  MAX_QUESTION_CHARS,
  checkClosesAt,
  normalizePollDraft,
} from "@/lib/forum/poll-rules";

/**
 * 建投票。
 *
 * ─────────────────────────────────────────
 * 站长说「投票只能看不能发」，是字面意思
 * ─────────────────────────────────────────
 *
 * `castVote` 接好了、`PollWidget` 渲染得好好的，
 * 而 **`createPoll` 写了 45 行，全站一个调用点都没有** ——
 * 能看能投，就是建不出来。又一次「声明了但没人调用」。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

describe("选项清洗", () => {
  it("去空白、丢空行", () => {
    const r = normalizePollDraft({ options: ["  同意 ", "", "   ", "反对"] });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.options, ["同意", "反对"]);
  });

  it("**去重按去空白之后算** —— 多个空格不该变成两个选项", () => {
    /*
     * 两个一模一样的选项在结果里没法区分，
     * 而投票的意义就在于结果能被读懂。
     */
    const r = normalizePollDraft({ options: ["同意", "同意 ", " 同意", "反对"] });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.options, ["同意", "反对"]);
  });

  it("少于两个不一样的选项 —— 拒绝", () => {
    for (const options of [[], ["只有一个"], ["同一个", "同一个"], ["", " "]]) {
      const r = normalizePollDraft({ options });
      assert.equal(r.ok, false, `${JSON.stringify(options)} 竟然通过了`);
    }
  });

  it("拒绝的理由要说清楚为什么", () => {
    const r = normalizePollDraft({ options: ["一个"] });
    if (r.ok) return assert.fail("应该拒绝");
    assert.match(r.error, /问不出任何东西/);
  });

  it("超过上限的截掉，不整个拒绝", () => {
    const many = Array.from({ length: MAX_OPTIONS + 5 }, (_, i) => `选项${i}`);
    const r = normalizePollDraft({ options: many });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.options.length, MAX_OPTIONS);
  });

  it("单个选项太长要截", () => {
    const r = normalizePollDraft({ options: ["长".repeat(200), "短"] });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.options[0].length, MAX_OPTION_CHARS);
  });

  it("问题可选，空的就是 null 而不是空串", () => {
    const a = normalizePollDraft({ options: ["A", "B"] });
    const b = normalizePollDraft({ question: "   ", options: ["A", "B"] });
    assert.equal(a.ok && a.question, null);
    assert.equal(b.ok && b.question, null);
  });

  it("问题太长要截", () => {
    const r = normalizePollDraft({ question: "问".repeat(200), options: ["A", "B"] });
    assert.equal(r.ok && r.question?.length, MAX_QUESTION_CHARS);
  });
});

describe("截止时间", () => {
  const NOW = 1_700_000_000_000;

  it("不设是正常的 —— 一个不截止的投票没有问题", () => {
    assert.equal(checkClosesAt(null, NOW), null);
    assert.equal(checkClosesAt(undefined, NOW), null);
  });

  it("**设在过去要拒** —— 那样投票一建出来就结束了", () => {
    /*
     * 界面上只会显示「已结束」，人会以为是自己点错了。
     */
    const r = checkClosesAt(NOW - 1000, NOW);
    assert.ok(r && !r.ok);
    if (!r || r.ok) return;
    assert.match(r.error, /过去/);
  });

  it("设在未来放行", () => {
    assert.equal(checkClosesAt(NOW + 86_400_000, NOW), null);
  });

  it("不是数字要拒", () => {
    const r = checkClosesAt(Number.NaN, NOW);
    assert.ok(r && !r.ok);
  });
});

describe("**两条创建路径共用同一份校验**", () => {
  it("createPoll 和 createPost 都调 normalizePollDraft", () => {
    /*
     * 各写一份的话迟早分叉，而分叉的表现是
     * 「从这个入口建的投票有 12 个选项上限，从那个入口建的没有」——
     * 没人查得出为什么。
     */
    assert.match(src("lib/forum/polls.ts"), /normalizePollDraft\(/);
    assert.match(src("lib/forum/actions.ts"), /normalizePollDraft\(/);
  });

  it("两边都查截止时间", () => {
    assert.match(src("lib/forum/polls.ts"), /checkClosesAt\(/);
    assert.match(src("lib/forum/actions.ts"), /checkClosesAt\(/);
  });

  it("规则层不碰数据库", () => {
    const code = src("lib/forum/poll-rules.ts");
    for (const forbidden of ["server-only", "@/lib/db", "drizzle-orm"]) {
      assert.equal(code.includes(forbidden), false, `规则层引了 ${forbidden}`);
    }
  });
});

describe("**投票和帖子在同一个事务里建**", () => {
  it("createPost 里直接插 polls，不是发完再调一次 createPoll", () => {
    /*
     * 分两次的话，中间失败会留下一个「类型是投票、但没有投票」的帖子 ——
     * 界面上那种帖子看起来就是坏的，作者也修不了。
     */
    const code = src("lib/forum/actions.ts");
    const create = code.slice(code.indexOf("export async function createPost"));
    const txStart = create.indexOf("db.transaction((tx)");
    const pollInsert = create.indexOf("insert(polls)");
    assert.ok(pollInsert > txStart && txStart > 0, "投票没在事务里建");
  });

  it("**校验在开事务之前** —— 一个填错的选项不该连累两千字回滚", () => {
    const code = src("lib/forum/actions.ts");
    const create = code.slice(code.indexOf("export async function createPost"));
    const check = create.indexOf("normalizePollDraft(");
    const tx = create.indexOf("db.transaction((tx)");
    assert.ok(check > 0 && check < tx, "校验放进事务里了");
  });

  it("带投票的帖子类型由服务端定 —— 两处各判一次迟早对不上", () => {
    const code = src("lib/forum/actions.ts");
    assert.match(code, /pollDraft \? "poll" :/);
  });

  it("**createReply 里没有混进投票逻辑**", () => {
    // 改的时候误加进去过一次，这条锁住
    const code = src("lib/forum/actions.ts");
    const reply = code.slice(code.indexOf("export async function createReply"));
    assert.doesNotMatch(reply, /normalizePollDraft|insert\(polls\)/);
  });
});

describe("界面", () => {
  const composer = src("components/forum/PollComposer.tsx");
  const form = src("components/forum/ComposeForm.tsx");

  it("**发帖界面真的能建投票了** —— 这是这一整块的目的", () => {
    assert.match(form, /<PollComposer/);
    assert.match(form, /{ key: "poll", label: "投票" }/);
    assert.match(form, /poll:\s*\n?\s*type === "poll"/);
  });

  it("**切走类型不清掉草稿** —— 点错一下四个选项全没了，而且没有任何提示", () => {
    assert.match(form, /投票草稿一直留着/);
    // setPoll 只在 PollComposer 的 onChange 里调，不在 setType 里
    const setTypeLine = form.slice(form.indexOf("onClick={() => setType(t.key)}"), form.indexOf("onClick={() => setType(t.key)}") + 120);
    assert.doesNotMatch(setTypeLine, /setPoll/);
  });

  it("空行不算数，所以清空一行就等于删掉它", () => {
    assert.match(composer, /空白项直接跳过|空着的行不会算进去/);
  });

  it("**只剩两个时不给真删** —— 删到一个的投票问不出任何东西", () => {
    assert.match(composer, /value\.options\.length <= 2/);
  });

  it("**当场告诉人「现在够不够」** —— 不说的话填完点发布才被告诉", () => {
    /*
     * 而那时候错误提示出现在页面顶部，他正看着底部的按钮。
     */
    assert.match(composer, /还差 \$\{2 - filled\} 个选项/);
  });

  it("投票编辑器排在正文上面 —— 写完两千字才发现下面还要填是很糟的顺序", () => {
    const pollAt = form.indexOf("<PollComposer");
    const editorAt = form.indexOf("<Editor");
    assert.ok(pollAt > 0 && pollAt < editorAt);
  });

  it("每个输入都有可访问的名字", () => {
    assert.match(composer, /aria-label=\{`选项 \$\{i \+ 1\}`\}/);
    assert.match(composer, /aria-label=\{`删除选项 \$\{i \+ 1\}`\}/);
  });

  it("用 SVG 图标不用 emoji", () => {
    assert.match(composer, /lucide-react/);
    assert.doesNotMatch(composer, /[\u{1F300}-\u{1FAFF}]/u);
  });
});

describe("落库", () => {
  const tmp = mkdtempSync(join(tmpdir(), "al-poll-"));
  process.env.DB_PATH = join(tmp, "test.db");
  process.env.NEKOBOT_API_KEY = "nk_test";

  let dbm: typeof import("@/lib/db");
  let schema: typeof import("@/lib/db/schema");

  before(async () => {
    dbm = await import("@/lib/db");
    schema = await import("@/lib/db/schema");
    const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
    migrate(dbm.db, { migrationsFolder: "./drizzle" });
  });

  after(() => rmSync(tmp, { recursive: true, force: true }));

  beforeEach(() => {
    for (const t of [schema.pollOptions, schema.polls, schema.posts]) dbm.db.delete(t).run();
  });

  it("选项按填的顺序存 —— 顺序被打乱的投票，结果读起来对不上", () => {
    dbm.db
      .insert(schema.posts)
      .values({
        id: "01POST000000000000000000A",
        boardId: "b1",
        authorId: "u1",
        title: "t",
        content: "c",
        contentHtml: "<p>c</p>",
        type: "poll",
        status: "published",
        shareCode: "abc",
      })
      .run();
    const poll = dbm.db
      .insert(schema.polls)
      .values({ postId: "01POST000000000000000000A" })
      .returning({ id: schema.polls.id })
      .get();

    ["甲", "乙", "丙"].forEach((text, sort) => {
      dbm.db.insert(schema.pollOptions).values({ pollId: poll.id, text, sort }).run();
    });

    const rows = dbm.db
      .select()
      .from(schema.pollOptions)
      .where(eq(schema.pollOptions.pollId, poll.id))
      .all()
      .sort((a, b) => a.sort - b.sort);
    assert.deepEqual(rows.map((r) => r.text), ["甲", "乙", "丙"]);
  });
});
