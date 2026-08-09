import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import {
  CONTEXT_AFTER,
  CONTEXT_BEFORE,
  CONTEXT_WINDOW_MS,
  EXPORT_DAILY_CAP,
  EXPORT_MIN_GAP_MS,
  MAX_OWN_MESSAGES,
  MESSAGE_BATCH,
  RUN_GAP_MS,
  WINDOW_MAX_MESSAGES,
  createPseudonyms,
  emptyCounts,
  exportFilename,
  exportRateVerdict,
  jsonl,
  runsOf,
} from "@/lib/export/self-export-rules";
import {
  draftLines,
  interactionLines,
  messageLines,
  postLines,
  replyLines,
  type Cursor,
  type ExportSource,
  type RawMessage,
} from "@/lib/export/self-export-stream";
import { zipStream } from "@/lib/export/zip";
import { stripComments as strip } from "./_source";

/**
 * 「下载我自己的全部数据」。
 *
 * ═════════════════════════════════════════
 * 这个功能存在的理由，和它最容易出的事
 * ═════════════════════════════════════════
 *
 * 站长要的是「能把自己的东西打包带走，拿去做数据蒸馏」。
 * 而**同一个功能正好是这个站上最容易破掉隐私约束的地方**：
 * 群聊是很多人一起说的，「含上下文」意味着导出里必然出现别人的发言；
 * 群列表本身是隐私；一份 zip 落到本地之后，站里那套权限就再也管不着它了。
 *
 * 所以这个文件里的断言分成四组，每一组对应一件「漏了就完了」的事：
 *   一、主体只能是发起人自己
 *   二、上下文的边界在哪
 *   三、几万条消息不会一次性读进内存
 *   四、限流与 zip 本身的正确性
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

/* ───────────────────────────────────────────────────────────────
 * 假数据源
 * ─────────────────────────────────────────────────────────────── */

const msg = (over: Partial<RawMessage> & { id: string; ts: number }): RawMessage => ({
  convId: "conv_a",
  senderWxId: "wx_other",
  isSend: false,
  type: "text",
  content: "内容",
  isQuality: false,
  hasMedia: false,
  ...over,
});

const afterCursor = (m: RawMessage, c: Cursor | null) =>
  c === null || m.ts > c.ts || (m.ts === c.ts && m.id > c.id);

interface FakeLog {
  /** 每次向数据库要了多少条 —— 「有没有真的分页」的唯一证据 */
  pageLimits: number[];
  pageCalls: number;
}

function fakeSource(
  over: Partial<ExportSource> & { all?: RawMessage[]; selfWxId?: string } = {},
): { source: ExportSource; log: FakeLog } {
  const all = (over.all ?? []).slice().sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
  const selfWxId = over.selfWxId ?? "wx_me";
  const own = all.filter((m) => m.senderWxId === selfWxId);
  const log: FakeLog = { pageLimits: [], pageCalls: 0 };

  const base: ExportSource = {
    ownMessageCount: () => own.length,
    ownMessageCutoff: (skip) => {
      const from新到旧 = own.slice().reverse();
      const row = from新到旧[skip];
      return row ? { ts: row.ts, id: row.id } : null;
    },
    ownMessagePage: (cursor, limit) => {
      log.pageCalls += 1;
      log.pageLimits.push(limit);
      return own.filter((m) => afterCursor(m, cursor)).slice(0, limit);
    },
    contextBefore: (convId, before, minTs, limit) =>
      all
        .filter(
          (m) =>
            m.convId === convId &&
            m.ts >= minTs &&
            (m.ts < before.ts || (m.ts === before.ts && m.id < before.id)),
        )
        // 真实实现是倒序取 limit 条，这里照抄那个语义
        .slice(-limit)
        .reverse(),
    windowBody: (convId, from, to, limit) =>
      all
        .filter(
          (m) =>
            m.convId === convId &&
            (m.ts > from.ts || (m.ts === from.ts && m.id >= from.id)) &&
            (m.ts < to.ts || (m.ts === to.ts && m.id <= to.id)),
        )
        .slice(0, limit),
    contextAfter: (convId, cursor, maxTs, limit) =>
      all
        .filter((m) => m.convId === convId && m.ts <= maxTs && afterCursor(m, cursor))
        .slice(0, limit),
    isVisibleGroup: () => true,
    groupName: (convId) => `群 ${convId}`,
    postsPage: () => [],
    repliesPage: () => [],
    draftsPage: () => [],
    bookmarksPage: () => [],
    reactionsPage: () => [],
    pollVotesPage: () => [],
    postContext: () => ({
      visible: true,
      reason: null,
      title: "原帖标题",
      excerpt: "原帖摘要",
      authorKey: "wx_other",
      authorIsSelf: false,
    }),
  };

  return { source: { ...base, ...over }, log };
}

async function collect(gen: AsyncGenerator<string>): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for await (const line of gen) out.push(JSON.parse(line));
  return out;
}

/* ═══════════════════════════════════════════════════════════════
 * 一、主体只能是发起人自己
 * ═══════════════════════════════════════════════════════════════ */

describe("**导出的主体只能是发起人自己**", () => {
  /*
   * 「导出某某人的数据」这个参数一旦存在，它就一定会在某一天
   * 被某个后台页面调用。所以判据不是「现在没人这么用」，
   * 而是**这条路由根本收不下这样一个参数**。
   */
  it("路由不接受任何指定用户的参数 —— 唯一可调的是要不要带上下文", () => {
    const route = strip(src("app/api/me/export/route.ts"));
    for (const forbidden of ["userId", "user_id", "wxId", "targetId", "subject"]) {
      assert.equal(
        new RegExp(`searchParams\\.get\\(["']${forbidden}`).test(route),
        false,
        `路由从 URL 上读了 ${forbidden}`,
      );
    }
    assert.match(route, /searchParams\.get\("context"\)/);
  });

  it("**用 getRealUser 而不是 getCurrentUser**", () => {
    /*
     * getCurrentUser() 在预览态下返回的是**被预览的那个人**。
     * 管理员开着「以某某身份浏览」点一下导出，就把别人的
     * 全部聊天记录打包带走了 —— 而这件事在任何日志里
     * 都会被记成那个被预览者自己导的。
     */
    const route = strip(src("app/api/me/export/route.ts"));
    assert.match(route, /getRealUser\(\)/);
    assert.equal(route.includes("getCurrentUser"), false);
  });

  it("预览态下这条路由直接当不存在", () => {
    const route = strip(src("app/api/me/export/route.ts"));
    assert.match(route, /currentPreview\(\)/);
    assert.match(route, /if \(!user \|\| preview\) return new Response\("Not Found", \{ status: 404 \}\)/);
  });

  it("取数层的主体是函数签名里的那个 user，不是请求参数", () => {
    const lib = strip(src("lib/export/self-export.ts"));
    assert.match(lib, /export function createExportSource\(user: CurrentUser\)/);
    // 每一条论坛查询都锁死在 user.id 上
    assert.match(lib, /eq\(posts\.authorId, user\.id\)/);
    assert.match(lib, /eq\(replies\.authorId, user\.id\)/);
    assert.match(lib, /eq\(drafts\.userId, user\.id\)/);
    assert.match(lib, /eq\(bookmarks\.userId, user\.id\)/);
  });

  it("**导出要记审计**，而且记的是条数不是内容", () => {
    /*
     * 把导出的正文再抄进审计表一遍，等于为了留痕又造了一份
     * 同样敏感的副本。事后要回答的问题是「这份文件从哪来的」，
     * 那只需要谁、什么时候、多大范围。
     */
    const route = strip(src("app/api/me/export/route.ts"));
    assert.match(route, /audit\(auditContextFrom\(request, user\.id\)/);
    // 只截 audit(...) 那一段来看，别把 Content-Type 之类的当成正文
    const call = route.slice(route.indexOf("audit(auditContextFrom"));
    const body = call.slice(0, call.indexOf("});") + 3);
    assert.match(body, /after: \{ record: recordId, withContext \}/);
    for (const leak of ["content", "text:", "before:", "messages"]) {
      assert.equal(body.includes(leak), false, `审计里出现了 ${leak}`);
    }
  });

  it("不许被任何一层缓存", () => {
    assert.match(strip(src("app/api/me/export/route.ts")), /no-store/);
  });

  it("规则层和组装层是纯的 —— 否则这些断言一条都跑不起来", () => {
    for (const file of ["lib/export/self-export-rules.ts", "lib/export/self-export-stream.ts"]) {
      const text = src(file);
      for (const forbidden of ["server-only", "@/lib/db", "drizzle-orm"]) {
        assert.equal(text.includes(forbidden), false, `${file} 引了 ${forbidden}`);
      }
    }
  });
});

/* ═══════════════════════════════════════════════════════════════
 * 二、上下文的边界
 * ═══════════════════════════════════════════════════════════════ */

describe("**上下文只给他此刻本来就读得到的东西**", () => {
  const own = (id: string, ts: number) => msg({ id, ts, senderWxId: "wx_me", content: `我${id}` });

  it("在的群：给上下文，也给群名", async () => {
    const { source } = fakeSource({
      all: [msg({ id: "b1", ts: 1000 }), own("m1", 2000), msg({ id: "a1", ts: 3000 })],
    });
    const [win] = await collect(
      messageLines(source, { withContext: true, selfWxId: "wx_me" }, emptyCounts()),
    );
    assert.equal((win.messages as unknown[]).length, 3);
    assert.equal(win.group, "群 conv_a");
  });

  it("**退掉的群：自己的话照导，上下文不给、群名也不给**", async () => {
    /*
     * 这是这一组里最要紧的一条。他退群之后在站内打开归档也看不到
     * 那个群现在的对话 —— 导出不该成为一条绕过它的路。
     * 但他当年说过的话仍然是他的，不能因为退群就没收。
     */
    const { source } = fakeSource({
      all: [msg({ id: "b1", ts: 1000 }), own("m1", 2000), msg({ id: "a1", ts: 3000 })],
      isVisibleGroup: () => false,
      groupName: () => null,
    });
    const [win] = await collect(
      messageLines(source, { withContext: true, selfWxId: "wx_me" }, emptyCounts()),
    );
    const messages = win.messages as { self: boolean }[];
    assert.equal(messages.length, 1, "混进了别人的发言");
    assert.equal(messages[0].self, true);
    assert.equal(win.group, null, "泄露了看不见的群的名字");
    assert.equal(win.conv, "conv_a", "conv_id 还在 —— 他自己知道在哪发过话");
  });

  it("关掉上下文时一条别人的话都不出现", async () => {
    const { source } = fakeSource({
      all: [msg({ id: "b1", ts: 1000 }), own("m1", 2000)],
    });
    const [win] = await collect(
      messageLines(source, { withContext: false, selfWxId: "wx_me" }, emptyCounts()),
    );
    assert.equal((win.messages as unknown[]).length, 1);
  });

  it("**上下文里的人换成代号，wx_id 和昵称都不出现**", async () => {
    const { source } = fakeSource({
      all: [msg({ id: "b1", ts: 1000, senderWxId: "wxid_fake_001" }), own("m1", 2000)],
    });
    const lines: string[] = [];
    for await (const line of messageLines(
      source,
      { withContext: true, selfWxId: "wx_me" },
      emptyCounts(),
    )) {
      lines.push(line);
    }
    const text = lines.join("");
    assert.equal(text.includes("wxid_fake_001"), false, "别人的 wx_id 漏进导出了");
    assert.match(text, /"speaker":"p1"/);
    assert.match(text, /"speaker":"self"/);
  });

  it("同一个人在整份导出里始终是同一个代号 —— 否则对话就对不上了", () => {
    const names = createPseudonyms("wx_me");
    assert.equal(names.labelFor("wx_a"), "p1");
    assert.equal(names.labelFor("wx_b"), "p2");
    assert.equal(names.labelFor("wx_a"), "p1");
    assert.equal(names.labelFor("wx_me"), "self", "自己绝不该被发代号");
  });

  it("正文原样保留 —— 改了就不叫上下文了", async () => {
    const { source } = fakeSource({
      all: [msg({ id: "b1", ts: 1000, content: "@张三 你看这个" }), own("m1", 2000)],
    });
    const [win] = await collect(
      messageLines(source, { withContext: true, selfWxId: "wx_me" }, emptyCounts()),
    );
    const first = (win.messages as { text: string }[])[0];
    assert.equal(first.text, "@张三 你看这个");
  });

  it("机器人有自己的标签，不占用 p1/p2 的号", async () => {
    const { source } = fakeSource({
      all: [msg({ id: "b1", ts: 1000, isSend: true }), own("m1", 2000)],
    });
    const [win] = await collect(
      messageLines(source, { withContext: true, selfWxId: "wx_me" }, emptyCounts()),
    );
    assert.equal((win.messages as { speaker: string }[])[0].speaker, "bot");
  });

  it("**上下文有时间上限** —— 三天前的那一条不是上下文，是另一场对话", async () => {
    const stale = msg({ id: "old", ts: 2000 - CONTEXT_WINDOW_MS - 1 });
    const near = msg({ id: "near", ts: 2000 - 1000 });
    const { source } = fakeSource({ all: [stale, near, own("m1", 2000)] });
    const [win] = await collect(
      messageLines(source, { withContext: true, selfWxId: "wx_me" }, emptyCounts()),
    );
    const texts = (win.messages as { text: string }[]).length;
    assert.equal(texts, 2, "把窗口外的旧消息也捞进来了");
  });

  it("前后各不超过约定的条数", async () => {
    const before = Array.from({ length: 20 }, (_, i) => msg({ id: `b${i}`, ts: 1000 + i }));
    const afters = Array.from({ length: 20 }, (_, i) => msg({ id: `a${i}`, ts: 3000 + i }));
    const { source } = fakeSource({ all: [...before, own("m1", 2000), ...afters] });
    const [win] = await collect(
      messageLines(source, { withContext: true, selfWxId: "wx_me" }, emptyCounts()),
    );
    assert.equal((win.messages as unknown[]).length, CONTEXT_BEFORE + 1 + CONTEXT_AFTER);
  });

  it("没绑微信的账号，群聊部分整体为空（而不是报错）", async () => {
    const { source } = fakeSource({ all: [] });
    const lines = await collect(
      messageLines(source, { withContext: true, selfWxId: null }, emptyCounts()),
    );
    assert.deepEqual(lines, []);
  });
});

describe("论坛：一条回复脱离原帖同样读不懂", () => {
  const reply = {
    id: "r1",
    postId: "p1",
    parentId: null,
    floor: 3,
    content: "我的回复",
    status: "published",
    accepted: false,
    anonymous: false,
    reactionCount: 0,
    createdAt: 1,
    deletedAt: null,
  };
  const opts = { withContext: true, selfWxId: "wx_me" };

  it("看得见原帖：带上标题和摘要，作者也换成代号", async () => {
    const { source } = fakeSource({ repliesPage: (a) => (a ? [] : [reply]) });
    const [row] = await collect(
      replyLines(source, opts, emptyCounts(), createPseudonyms("wx_me")),
    );
    const context = row.context as { title: string; author: string };
    assert.equal(context.title, "原帖标题");
    assert.equal(context.author, "p1");
    assert.equal(row.contextReason, null);
  });

  it("**看不见原帖：如实写明为什么没有**，而不是悄悄留一个空标题", async () => {
    /*
     * 悄悄留空的话，三个月后读这份数据的人会以为那些帖子本来就没标题，
     * 然后把它当成脏数据清掉 —— 而真相是「他当时看不到」。
     */
    const { source } = fakeSource({
      repliesPage: (a) => (a ? [] : [reply]),
      postContext: () => ({
        visible: false,
        reason: "仅作者可见",
        title: null,
        excerpt: null,
        authorKey: "wx_other",
        authorIsSelf: false,
      }),
    });
    const [row] = await collect(
      replyLines(source, opts, emptyCounts(), createPseudonyms("wx_me")),
    );
    assert.equal(row.context, null);
    assert.equal(row.contextReason, "仅作者可见");
    assert.equal(row.content, "我的回复", "自己写的那句永远都在");
  });

  it("关掉上下文时连原帖标题都不给 —— 标题也是别人写的", async () => {
    const { source } = fakeSource({ repliesPage: (a) => (a ? [] : [reply]) });
    const [row] = await collect(
      replyLines(
        source,
        { withContext: false, selfWxId: "wx_me" },
        emptyCounts(),
        createPseudonyms("wx_me"),
      ),
    );
    assert.equal(row.context, null);
  });

  it("**同一个人在群聊和论坛里是同一个代号**，否则两个文件对不上", async () => {
    const names = createPseudonyms("wx_me");
    names.labelFor("wx_other");
    const { source } = fakeSource({ repliesPage: (a) => (a ? [] : [reply]) });
    const [row] = await collect(replyLines(source, opts, emptyCounts(), names));
    assert.equal((row.context as { author: string }).author, "p1");
  });

  it("草稿是自己写的东西，一条不落", async () => {
    const { source } = fakeSource({
      draftsPage: (a) =>
        a
          ? []
          : [
              {
                id: "d1",
                targetType: "post",
                targetId: null,
                boardId: "b1",
                title: "没写完的",
                content: "正文",
                updatedAt: 1,
              },
            ],
    });
    const counts = emptyCounts();
    const [row] = await collect(draftLines(source, counts));
    assert.equal(row.title, "没写完的");
    assert.equal(counts.drafts, 1);
  });

  it("收藏、表态、投票合成一个文件，用 kind 区分", async () => {
    const one = (id: string) => ({
      id,
      targetType: "post",
      targetId: "p1",
      detail: null,
      createdAt: 1,
    });
    const { source } = fakeSource({
      bookmarksPage: (a) => (a ? [] : [{ ...one("bk1"), kind: "bookmark" as const }]),
      reactionsPage: (a) => (a ? [] : [{ ...one("rx1"), kind: "reaction" as const }]),
      pollVotesPage: (a) => (a ? [] : [{ ...one("pv1"), kind: "poll_vote" as const }]),
    });
    const counts = emptyCounts();
    const rows = await collect(interactionLines(source, counts));
    assert.deepEqual(
      rows.map((r) => r.kind),
      ["bookmark", "reaction", "poll_vote"],
    );
    assert.equal(counts.interactions, 3);
  });
});

describe("切段：一段连续对话，不是一条消息配一份上下文", () => {
  const ref = (id: string, ts: number, convId = "c1") => ({ id, convId, ts });

  it("**同群、间隔够近的合成一段** —— 否则连发 10 条会得到 10 份 90% 重复的片段", async () => {
    const runs = [];
    for await (const run of runsOf([ref("a", 0), ref("b", 1000), ref("c", 2000)])) runs.push(run);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].own.length, 3);
  });

  it("超过间隔就断开 —— 隔了一小时那是两件事", async () => {
    const runs = [];
    for await (const run of runsOf([ref("a", 0), ref("b", RUN_GAP_MS + 1)])) runs.push(run);
    assert.equal(runs.length, 2);
  });

  it("换了群一定断开，绝不把两个群的话拼进同一段", async () => {
    const runs = [];
    for await (const run of runsOf([ref("a", 0, "c1"), ref("b", 10, "c2")])) runs.push(run);
    assert.equal(runs.length, 2);
    assert.deepEqual(
      runs.map((r) => r.convId),
      ["c1", "c2"],
    );
  });

  it("一段封顶，防止一次刷屏把整段撑到内存里", async () => {
    const many = Array.from({ length: 130 }, (_, i) => ref(`m${i}`, i));
    const runs = [];
    for await (const run of runsOf(many, RUN_GAP_MS, 50)) runs.push(run);
    assert.equal(runs.length, 3);
    assert.equal(Math.max(...runs.map((r) => r.own.length)), 50);
  });

  it("空输入产出空，不产出一段空窗口", async () => {
    const runs = [];
    for await (const run of runsOf([])) runs.push(run);
    assert.deepEqual(runs, []);
  });
});

describe("**一段里挤了几千条时，先保住自己的话**", () => {
  it("中间的上下文整段丢掉，而不是截前 N 条把自己也截没", async () => {
    /*
     * 「截前 200 条」看起来温和，但那 200 条里可能一条自己的都没有 ——
     * 于是一次「导出自己的数据」把自己的数据弄丢了。
     * 宁可这一段没有上下文。
     */
    const flood = Array.from({ length: WINDOW_MAX_MESSAGES + 50 }, (_, i) =>
      msg({ id: `f${String(i).padStart(4, "0")}`, ts: 1000 + i }),
    );
    const mine = [
      msg({ id: "z_first", ts: 1000, senderWxId: "wx_me" }),
      msg({ id: "z_last", ts: 1000 + flood.length, senderWxId: "wx_me" }),
    ];
    const { source } = fakeSource({ all: [...mine, ...flood] });

    const [win] = await collect(
      messageLines(source, { withContext: true, selfWxId: "wx_me" }, emptyCounts()),
    );
    assert.equal(win.truncated, true);
    const selfKept = (win.messages as { self: boolean }[]).filter((m) => m.self).length;
    assert.equal(selfKept, 2, "自己的发言被截掉了");
  });
});

/* ═══════════════════════════════════════════════════════════════
 * 三、几万条消息不会一次性读进内存
 * ═══════════════════════════════════════════════════════════════ */

describe("**几万条消息不会一次性读进内存**", () => {
  const bulk = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      msg({
        id: `m${String(i).padStart(6, "0")}`,
        // 每条都隔开，保证一条消息一段，段数最大化
        ts: (i + 1) * (RUN_GAP_MS + 1000),
        senderWxId: "wx_me",
      }),
    );

  it("**每次向数据库要的条数都有上界**", async () => {
    const { source, log } = fakeSource({ all: bulk(1200) });
    for await (const _ of messageLines(
      source,
      { withContext: false, selfWxId: "wx_me" },
      emptyCounts(),
    )) {
      void _;
    }
    assert.equal(log.pageLimits.length > 1, true, "一次就取完了 —— 根本没有分页");
    assert.equal(Math.max(...log.pageLimits), MESSAGE_BATCH);
  });

  it("**取第一行时数据库只被问过一次** —— 这才叫流式", async () => {
    /*
     * 这一条是真正的判据。上面那条只能证明「分了页」，
     * 而一个先把所有页拼成数组再返回的实现同样能通过它 ——
     * 那种实现的内存占用和不分页是一样的。
     */
    const { source, log } = fakeSource({ all: bulk(5000) });
    const gen = messageLines(source, { withContext: false, selfWxId: "wx_me" }, emptyCounts());
    await gen.next();
    assert.equal(log.pageCalls, 1, `取一行就查了 ${log.pageCalls} 次，说明它先跑完了全部`);
    await gen.return(undefined);
  });

  it("产出是生成器不是字符串 —— 一个 return string 的函数一定把整份攒在内存里", () => {
    const stream = strip(src("lib/export/self-export-stream.ts"));
    for (const fn of ["messageLines", "postLines", "replyLines", "draftLines", "interactionLines"]) {
      assert.match(
        stream,
        new RegExp(`export async function\\* ${fn}\\(`),
        `${fn} 不是 async generator`,
      );
    }
  });

  it("**取数接口的每个方法都带 limit**，签名上就不允许「全部」", () => {
    const stream = strip(src("lib/export/self-export-stream.ts"));
    const iface = stream.slice(
      stream.indexOf("export interface ExportSource"),
      stream.indexOf("export interface StreamOptions"),
    );
    for (const line of iface.split("\n")) {
      if (!/^\s{2}\w+\(/.test(line)) continue;
      if (/ownMessageCount|ownMessageCutoff|isVisibleGroup|groupName|postContext/.test(line)) continue;
      assert.match(line, /limit: number/, `这个方法没有 limit：${line.trim()}`);
    }
  });

  it("真正落库的那一层，每条读消息的 SQL 都有 limit 或者只是 count", () => {
    const lib = strip(src("lib/export/self-export.ts"));
    const spans = lib.match(/db[\s\S]{0,700}?\.(all|get)\(\)/g) ?? [];
    const messageSpans = spans.filter((s) => s.includes("from(messages)"));
    assert.equal(messageSpans.length > 0, true, "没找到读消息的查询，正则该改了");
    for (const span of messageSpans) {
      assert.equal(
        span.includes(".limit(") || span.includes("count(*)"),
        true,
        `一条没有上界的消息查询：${span.slice(0, 120)}`,
      );
    }
  });

  it("超过上限时**留最新的**，并且如实标记截断了", async () => {
    const { source } = fakeSource({ all: bulk(30) });
    const counts = emptyCounts();
    // 用一个很小的上限模拟不了 MAX_OWN_MESSAGES（它是常量），
    // 所以这里验的是「没超上限时不该谎报截断」这一半
    for await (const _ of messageLines(source, { withContext: false, selfWxId: "wx_me" }, counts)) {
      void _;
    }
    assert.equal(counts.truncated, false);
    assert.equal(counts.ownMessages, 30);
  });

  it("上限是个真数字，不是「等以后再说」", () => {
    assert.equal(Number.isFinite(MAX_OWN_MESSAGES), true);
    assert.equal(MAX_OWN_MESSAGES > 0, true);
    assert.equal(MESSAGE_BATCH < MAX_OWN_MESSAGES, true, "一页就能装下上限，等于没分页");
  });

  it("论坛四类内容也是一页一页取的", async () => {
    let calls = 0;
    const rows = Array.from({ length: 450 }, (_, i) => ({
      id: `p${String(i).padStart(4, "0")}`,
      boardKey: "b",
      boardName: "版块",
      title: "标题",
      content: "正文",
      type: "discussion",
      status: "published",
      visibility: "member",
      anonymous: false,
      pinned: false,
      replyCount: 0,
      reactionCount: 0,
      viewCount: 0,
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
      tags: [],
    }));
    const { source } = fakeSource({
      postsPage: (afterId, limit) => {
        calls += 1;
        return rows.filter((r) => afterId === null || r.id > afterId).slice(0, limit);
      },
    });
    const counts = emptyCounts();
    const out = await collect(postLines(source, counts));
    assert.equal(out.length, 450);
    assert.equal(counts.posts, 450);
    assert.equal(calls > 1, true, "论坛内容一把捞完了");
  });
});

/* ═══════════════════════════════════════════════════════════════
 * 四、限流
 * ═══════════════════════════════════════════════════════════════ */

describe("**限流：打包一份是重活，不能被人按住 F5**", () => {
  const NOW = Date.UTC(2026, 7, 9, 12, 0, 0);

  it("从来没导过：放行", () => {
    assert.equal(exportRateVerdict([], NOW).allowed, true);
  });

  it("刚导完：拦住，并且告诉他还要等几分钟", () => {
    const verdict = exportRateVerdict([NOW - 60_000], NOW);
    assert.equal(verdict.allowed, false);
    assert.match(verdict.message, /分钟/);
    assert.equal(verdict.retryAfterSeconds > 0, true);
  });

  it("过了间隔就能再导", () => {
    assert.equal(exportRateVerdict([NOW - EXPORT_MIN_GAP_MS - 1], NOW).allowed, true);
  });

  it("**一天封顶** —— 否则每半小时挂个脚本跑一次照样把机器占满", () => {
    const starts = Array.from(
      { length: EXPORT_DAILY_CAP },
      (_, i) => NOW - (i + 1) * (EXPORT_MIN_GAP_MS + 1000),
    );
    const verdict = exportRateVerdict(starts, NOW);
    assert.equal(verdict.allowed, false);
    assert.match(verdict.message, /今天/);
  });

  it("昨天的次数不算进今天", () => {
    const old = Array.from({ length: 10 }, (_, i) => NOW - 86_400_000 - i * 1000);
    assert.equal(exportRateVerdict(old, NOW).allowed, true);
  });

  it("Retry-After 永远是正数 —— 0 会让客户端立刻重试", () => {
    const verdict = exportRateVerdict([NOW], NOW);
    assert.equal(verdict.retryAfterSeconds >= 1, true);
  });

  it("路由按判定回 429 并带上 Retry-After", () => {
    const route = strip(src("app/api/me/export/route.ts"));
    assert.match(route, /status: 429/);
    assert.match(route, /"Retry-After": String\(rate\.retryAfterSeconds\)/);
  });

  it("**限流数的是「发起」不是「完成」**", () => {
    /*
     * 一次跑到一半崩掉的导出照样消耗了那台机器的时间片。
     * 按完成计数的话，把请求打断就是一次免费重试 ——
     * 而打断请求恰恰是最容易做到的事。
     */
    const lib = strip(src("lib/export/self-export.ts"));
    assert.match(lib, /gte\(dataExports\.startedAt, now - EXPORT_DAY_MS\)/);
    assert.equal(
      /recentExportStarts[\s\S]*?eq\(dataExports\.status, "completed"\)/.test(lib),
      false,
      "限流只数成功的那些",
    );
    // 行必须在开跑之前插进去
    const route = strip(src("app/api/me/export/route.ts"));
    assert.equal(
      route.indexOf("beginExport(") < route.indexOf("selfExportZip("),
      true,
      "先干活后记账，等于中途崩掉就不占配额",
    );
  });

  it("三条出口都会把那一行结掉，不会永远停在 started", () => {
    const route = strip(src("app/api/me/export/route.ts"));
    assert.match(route, /finishExport\(recordId/);
    assert.match(route, /catch[\s\S]*?failExport\(recordId/);
    // 用户取消下载时生成器被 return，既不走 catch 也不走成功分支
    assert.match(route, /finally \{[\s\S]*?failExport\(recordId/);
  });

  it("限流是**用户侧**的：这条路由不在后台，没有管理员豁免", () => {
    const route = strip(src("app/api/me/export/route.ts"));
    assert.equal(route.includes("requireAdmin"), false);
    assert.equal(route.includes("can("), false);
  });
});

/* ═══════════════════════════════════════════════════════════════
 * 五、zip 本身
 * ═══════════════════════════════════════════════════════════════ */

const tmp = mkdtempSync(join(tmpdir(), "al-selfexport-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

async function buildZip(entries: { name: string; text: string }[]): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of zipStream(
    entries.map((e) => ({
      name: e.name,
      content: async function* () {
        // 故意分两块吐，逼出「跨块累计 crc 和大小」那条路径
        yield e.text.slice(0, Math.ceil(e.text.length / 2));
        yield e.text.slice(Math.ceil(e.text.length / 2));
      },
    })),
    Date.UTC(2026, 7, 9, 12, 0, 0),
  )) {
    chunks.push(chunk);
  }
  const path = join(tmp, `${Math.random().toString(36).slice(2)}.zip`);
  writeFileSync(path, Buffer.concat(chunks));
  return path;
}

describe("**zip 得是真的能解开的 zip**", () => {
  /*
   * 这一组全部交给系统的 unzip 来判。自己写的解析器只会
   * 和自己写的打包器一起错 —— 那正是「测了等于没测」。
   */
  it("unzip -t 通过（也就是每个文件的 crc32 都对得上）", async () => {
    const path = await buildZip([
      { name: "README.md", text: "# 我的数据导出\n里面有别人的发言。\n" },
      { name: "messages.jsonl", text: `${jsonl({ conv: "c1" })}${jsonl({ conv: "c2" })}` },
    ]);
    const out = execFileSync("unzip", ["-t", path], { encoding: "utf8" });
    assert.match(out, /No errors detected/);
  });

  it("**中文正文解出来还是中文** —— 压包时把编码搞坏是最难查的一类", async () => {
    const path = await buildZip([{ name: "profile.json", text: '{"nickname":"阿猫"}\n' }]);
    const out = execFileSync("unzip", ["-p", path, "profile.json"], { encoding: "utf8" });
    assert.equal(out, '{"nickname":"阿猫"}\n');
  });

  it("文件都在，名字也对", async () => {
    const names = ["README.md", "manifest.json", "profile.json", "messages.jsonl"];
    const path = await buildZip(names.map((n) => ({ name: n, text: `${n} 的内容\n` })));
    const listing = execFileSync("unzip", ["-Z1", path], { encoding: "utf8" }).trim().split("\n");
    assert.deepEqual(listing, names);
  });

  it("空文件也要在包里 —— 一个不存在的 messages.jsonl 会被当成导出坏了", async () => {
    const path = await buildZip([{ name: "messages.jsonl", text: "" }]);
    assert.match(execFileSync("unzip", ["-t", path], { encoding: "utf8" }), /No errors detected/);
    assert.equal(execFileSync("unzip", ["-p", path, "messages.jsonl"], { encoding: "utf8" }), "");
  });

  it("真被压过了，不是换了个后缀的裸文件", async () => {
    const text = `${"重复的一行\n".repeat(500)}`;
    const path = await buildZip([{ name: "big.jsonl", text }]);
    const size = readFileSync(path).length;
    assert.equal(size < Buffer.byteLength(text) / 2, true, `压完还有 ${size} 字节`);
  });

  it("**打包是流式的**：条目内容是函数，轮到它才开始产出", () => {
    const zip = strip(src("lib/export/zip.ts"));
    assert.match(zip, /content: \(\) => AsyncIterable/);
    // 数据描述符那一位必须置上，否则就只能先攒完再写头
    assert.match(zip, /FLAG_DATA_DESCRIPTOR_UTF8 = 0x0808/);
  });

  it("超过 4 GiB 时**抛错**，而不是让字段悄悄溢出", () => {
    const zip = strip(src("lib/export/zip.ts"));
    assert.match(zip, /throw new Error\(`\$\{entry\.name\} 超过 4 GiB/);
  });

  it("下载流是 pull 驱动的 —— push 模式的队列会把整包又攒回内存", () => {
    const zip = strip(src("lib/export/zip.ts"));
    assert.match(zip, /async pull\(controller\)/);
    assert.match(zip, /async cancel\(reason\)/);
  });
});

describe("文件名", () => {
  it("带日期 —— 一个人会导好几次", () => {
    assert.equal(exportFilename("2026-08-09"), "我的数据-2026-08-09.zip");
  });
});

/* ═══════════════════════════════════════════════════════════════
 * 六、说明文件
 * ═══════════════════════════════════════════════════════════════ */

describe("**没有说明的数据集，三个月后连导出的人自己都不认得**", () => {
  it("README 和 manifest 都在包里，而且 README 排在最前", () => {
    const lib = strip(src("lib/export/self-export.ts"));
    assert.equal(
      lib.indexOf("FILES.readme") < lib.indexOf("FILES.messages"),
      true,
      "README 不在最前，解压后第一眼看不到警告",
    );
    // manifest 要写真实条数，只能等前面都压完
    assert.equal(lib.lastIndexOf("FILES.manifest") > lib.indexOf("FILES.interactions"), true);
  });

  it("README 里必须写明「这里面有别人的发言」和责任归属", async () => {
    const { buildReadme } = await import("@/lib/export/self-export-rules");
    const text = buildReadme({
      exportedAt: 0,
      exportedAtLocal: "2026-08-09 20:00",
      userId: "u_1",
      withContext: true,
      counts: emptyCounts(),
      visibleGroups: 3,
    });
    assert.match(text, /这里面有别人的发言/);
    assert.match(text, /责任在你/);
    assert.match(text, /假名化/);
    assert.match(text, /jsonl/i);
  });

  it("manifest 说清每个文件是什么，还带上限和条数", async () => {
    const { buildManifest, FILES } = await import("@/lib/export/self-export-rules");
    const m = buildManifest({
      exportedAt: 1,
      exportedAtLocal: "2026-08-09 20:00",
      userId: "u_1",
      withContext: true,
      counts: emptyCounts(),
      visibleGroups: 3,
    });
    assert.equal(m.format, "agenticlab-self-export");
    for (const file of Object.values(FILES)) {
      if (file === FILES.readme || file === FILES.manifest) continue;
      assert.equal(typeof m.files[file], "string", `${file} 没有说明`);
    }
    assert.match(m.notice, /他人/);
    assert.equal(m.limits.maxOwnMessages, MAX_OWN_MESSAGES);
  });

  it("jsonl 一行一条，正文里的换行不会把一行拆成两行", () => {
    const line = jsonl({ text: "上\n下" });
    assert.equal(line.split("\n").length, 2, "一条记录变成了两行");
    assert.equal(JSON.parse(line).text, "上\n下");
  });
});

/* ═══════════════════════════════════════════════════════════════
 * 七、真数据库
 * ═══════════════════════════════════════════════════════════════ */

process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

let dbm: typeof import("@/lib/db");
let schema: typeof import("@/lib/db/schema");
let selfExport: typeof import("@/lib/export/self-export");

const ME = "u_me";
const OTHER = "u_other";
const MY_GROUP = "conv_mine";
const LEFT_GROUP = "conv_left";

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  selfExport = await import("@/lib/export/self-export");
});

const putMessage = (over: {
  id: string;
  convId: string;
  senderWxId: string;
  ts: number;
  content?: string;
}) =>
  dbm.db
    .insert(schema.messages)
    .values({
      id: over.id,
      convId: over.convId,
      senderWxId: over.senderWxId,
      type: "text",
      content: over.content ?? "内容",
      ts: over.ts,
    })
    .run();

beforeEach(() => {
  for (const table of [
    schema.messages,
    schema.groupMembers,
    schema.groups,
    schema.users,
    schema.dataExports,
    schema.posts,
    schema.replies,
  ]) {
    dbm.db.delete(table).run();
  }

  dbm.db
    .insert(schema.users)
    .values([
      { id: ME, wxId: "wx_me", siteNickname: "我", status: "active" },
      { id: OTHER, wxId: "wx_other", siteNickname: "别人", status: "active" },
    ])
    .run();

  dbm.db
    .insert(schema.groups)
    .values([
      { convId: MY_GROUP, name: "我在的群", syncEnabled: true },
      { convId: LEFT_GROUP, name: "退掉的群", syncEnabled: true },
    ])
    .run();

  dbm.db
    .insert(schema.groupMembers)
    .values([
      { convId: MY_GROUP, wxId: "wx_me" },
      { convId: MY_GROUP, wxId: "wx_other" },
      // 退群：leftAt 一有值就立刻失去该群的可见权
      { convId: LEFT_GROUP, wxId: "wx_me", leftAt: 1 },
    ])
    .run();
});

const userById = (id: string) =>
  dbm.db.select().from(schema.users).where(eq(schema.users.id, id)).get()!;

describe("接到真库上（真数据库）", () => {
  it("**只导出自己发的消息，别人的绝不作为「我的消息」出现**", async () => {
    putMessage({ id: "m1", convId: MY_GROUP, senderWxId: "wx_me", ts: 1000, content: "我说的" });
    putMessage({
      id: "m2",
      convId: MY_GROUP,
      senderWxId: "wx_other",
      ts: 2000,
      content: "别人说的",
    });

    const source = selfExport.createExportSource(userById(ME));
    const own = source.ownMessagePage(null, 100);
    assert.deepEqual(
      own.map((m) => m.id),
      ["m1"],
    );
  });

  it("**退掉的群：自己的话在，上下文查不出来**", () => {
    putMessage({ id: "L1", convId: LEFT_GROUP, senderWxId: "wx_me", ts: 1000 });
    putMessage({ id: "L2", convId: LEFT_GROUP, senderWxId: "wx_other", ts: 1500 });

    const source = selfExport.createExportSource(userById(ME));
    assert.equal(source.ownMessagePage(null, 100).length, 1, "退群就把自己的话没收了");
    assert.equal(source.isVisibleGroup(LEFT_GROUP), false);
    assert.equal(source.groupName(LEFT_GROUP), null);
    assert.equal(
      source.contextBefore(LEFT_GROUP, { ts: 9999, id: "z" }, 0, 10).length,
      0,
      "看不见的群还是把别人的话捞出来了",
    );
  });

  it("在的群拿得到群名和上下文", () => {
    putMessage({ id: "m1", convId: MY_GROUP, senderWxId: "wx_other", ts: 1000 });
    putMessage({ id: "m2", convId: MY_GROUP, senderWxId: "wx_me", ts: 2000 });

    const source = selfExport.createExportSource(userById(ME));
    assert.equal(source.groupName(MY_GROUP), "我在的群");
    assert.equal(source.contextBefore(MY_GROUP, { ts: 2000, id: "m2" }, 0, 10).length, 1);
  });

  it("**时间戳撞了也不会漏消息、不会重复** —— 同一秒发两条是常事", () => {
    putMessage({ id: "a", convId: MY_GROUP, senderWxId: "wx_me", ts: 1000 });
    putMessage({ id: "b", convId: MY_GROUP, senderWxId: "wx_me", ts: 1000 });
    putMessage({ id: "c", convId: MY_GROUP, senderWxId: "wx_me", ts: 1000 });

    const source = selfExport.createExportSource(userById(ME));
    const seen: string[] = [];
    let cursor: { ts: number; id: string } | null = null;
    for (let i = 0; i < 5; i += 1) {
      const page: { ts: number; id: string }[] = source.ownMessagePage(cursor, 1);
      if (page.length === 0) break;
      seen.push(page[0].id);
      cursor = { ts: page[0].ts, id: page[0].id };
    }
    assert.deepEqual(seen, ["a", "b", "c"]);
  });

  it("超上限时的起始游标指向「最新 N 条」的前一条", () => {
    for (let i = 0; i < 10; i += 1) {
      putMessage({ id: `m${i}`, convId: MY_GROUP, senderWxId: "wx_me", ts: 1000 + i });
    }
    const source = selfExport.createExportSource(userById(ME));
    assert.equal(source.ownMessageCount(), 10);
    // 保留最新 3 条 ⇒ 游标是从新往旧数的第 4 条，也就是 m6
    assert.equal(source.ownMessageCutoff(3)?.id, "m6");
    assert.deepEqual(
      source.ownMessagePage(source.ownMessageCutoff(3), 100).map((m) => m.id),
      ["m7", "m8", "m9"],
    );
  });

  it("论坛：只捞自己的帖子和回复", () => {
    dbm.db
      .insert(schema.posts)
      .values([
        {
          id: "p_mine",
          boardId: "b1",
          authorId: ME,
          title: "我的帖",
          content: "正文",
          contentHtml: "<p>正文</p>",
        },
        {
          id: "p_other",
          boardId: "b1",
          authorId: OTHER,
          title: "别人的帖",
          content: "正文",
          contentHtml: "<p>正文</p>",
        },
      ])
      .run();

    const source = selfExport.createExportSource(userById(ME));
    assert.deepEqual(
      source.postsPage(null, 100).map((p) => p.id),
      ["p_mine"],
    );
  });

  it("**看不见的帖子只给一个原因，不给标题**", () => {
    /*
     * 「仅作者可见」的帖子，标题也是内容。回复的上下文只在
     * 他此刻仍看得见原帖时才给 —— 而且要如实说明为什么没给，
     * 悄悄留空会让人以为原帖本来就是空的。
     */
    dbm.db
      .insert(schema.posts)
      .values({
        id: "p_secret",
        boardId: "b1",
        authorId: OTHER,
        title: "别人的私密帖",
        content: "正文",
        contentHtml: "<p>正文</p>",
        visibility: "private",
      })
      .run();

    const ctx = selfExport.createExportSource(userById(ME)).postContext("p_secret");
    assert.equal(ctx.visible, false);
    assert.equal(ctx.title, null, "标题漏出去了");
    assert.equal(typeof ctx.reason, "string");
  });

  it("原帖已经没了也要给个说法，不能抛异常把整份导出带崩", () => {
    const ctx = selfExport.createExportSource(userById(ME)).postContext("p_gone");
    assert.equal(ctx.visible, false);
    assert.match(ctx.reason ?? "", /不存在/);
  });

  it("限流读的是自己那几行，别人的导出不算在他头上", () => {
    const id = selfExport.beginExport(ME, { withContext: true });
    selfExport.beginExport(OTHER, { withContext: true });

    assert.equal(selfExport.recentExportStarts(ME, Date.now()).length, 1);
    assert.equal(selfExport.checkExportRate(ME).allowed, false, "刚导过还放行");
    assert.equal(selfExport.checkExportRate("u_nobody").allowed, true);

    selfExport.finishExport(id, { ...emptyCounts(), ownMessages: 7 }, 12345);
    const [row] = selfExport.myRecentExports(ME);
    assert.equal(row.status, "completed");
    assert.equal(row.ownMessages, 7);
    assert.equal(row.bytes, 12345);
  });

  it("失败的那一次也留在历史里 —— 不然用户只会看到「什么都没发生」", () => {
    const id = selfExport.beginExport(ME, { withContext: false });
    selfExport.failExport(id, "下载中断");
    const [row] = selfExport.myRecentExports(ME);
    assert.equal(row.status, "failed");
    assert.equal(row.withContext, false);
  });

  it("**端到端：解出来的包里有别人的话，但没有别人的 wx_id**", async () => {
    putMessage({
      id: "m1",
      convId: MY_GROUP,
      senderWxId: "wx_other",
      ts: 1000,
      content: "上一句",
    });
    putMessage({
      id: "m2",
      convId: MY_GROUP,
      senderWxId: "wx_me",
      ts: 2000,
      content: "我说的那句",
    });

    const run = selfExport.selfExportZip(userById(ME), { withContext: true });
    const chunks: Uint8Array[] = [];
    for await (const chunk of run.stream) chunks.push(chunk);
    const path = join(tmp, "e2e.zip");
    writeFileSync(path, Buffer.concat(chunks));

    assert.match(execFileSync("unzip", ["-t", path], { encoding: "utf8" }), /No errors detected/);

    const listing = execFileSync("unzip", ["-Z1", path], { encoding: "utf8" }).trim().split("\n");
    assert.deepEqual(listing, [
      "README.md",
      "profile.json",
      "messages.jsonl",
      "forum-posts.jsonl",
      "forum-replies.jsonl",
      "forum-drafts.jsonl",
      "forum-interactions.jsonl",
      "manifest.json",
    ]);

    const messages = execFileSync("unzip", ["-p", path, "messages.jsonl"], { encoding: "utf8" });
    assert.match(messages, /上一句/, "上下文没导出来");
    assert.match(messages, /我说的那句/);
    assert.match(messages, /"speaker":"p1"/);
    assert.equal(messages.includes("wx_other"), false, "别人的 wx_id 漏进导出了");
    assert.match(messages, /"group":"我在的群"/);

    const manifest = JSON.parse(execFileSync("unzip", ["-p", path, "manifest.json"], { encoding: "utf8" }));
    assert.equal(manifest.subjectUserId, ME);
    assert.equal(manifest.counts.ownMessages, 1);
    assert.equal(manifest.counts.contextMessages, 1);
    assert.equal(manifest.counts.pseudonyms, 1);

    const profile = JSON.parse(execFileSync("unzip", ["-p", path, "profile.json"], { encoding: "utf8" }));
    assert.equal(profile.id, ME);
    assert.equal(profile.wxId, "wx_me", "自己的 wx_id 是自己的数据，该给");
    // 密码哈希、会话令牌一类东西一个都不该出现在这份文件里
    assert.equal("secret" in profile, false);
    assert.equal("meta" in profile, false);

    const readme = execFileSync("unzip", ["-p", path, "README.md"], { encoding: "utf8" });
    assert.match(readme, /这里面有别人的发言/);
  });

  it("没绑微信的人也能导 —— 拿到的是一个只有账号信息的包，不是一个错误", async () => {
    dbm.db
      .insert(schema.users)
      .values({ id: "u_ext", wxId: null, siteNickname: "外部", kind: "external", status: "active" })
      .run();
    const ext = userById("u_ext");

    const run = selfExport.selfExportZip(ext, { withContext: true });
    const chunks: Uint8Array[] = [];
    for await (const chunk of run.stream) chunks.push(chunk);
    const path = join(tmp, "ext.zip");
    writeFileSync(path, Buffer.concat(chunks));

    assert.match(execFileSync("unzip", ["-t", path], { encoding: "utf8" }), /No errors detected/);
    assert.equal(execFileSync("unzip", ["-p", path, "messages.jsonl"], { encoding: "utf8" }), "");
  });
});

/* ═══════════════════════════════════════════════════════════════
 * 八、界面
 * ═══════════════════════════════════════════════════════════════ */

describe("界面：手机端电脑端都得有，而且不能点一下没反应", () => {
  it("个人中心里有入口", () => {
    assert.match(strip(src("app/(app)/me/page.tsx")), /href="\/me\/export"/);
  });

  it("**警告排在按钮前面**", () => {
    /*
     * 反过来的话，绝大多数人会先点，下完才发现里面有别人的发言 ——
     * 那时候这份文件已经在他硬盘上了。
     */
    const page = strip(src("app/(app)/me/export/page.tsx"));
    // 找的是 JSX 里那个标签，不是文件顶上的 import
    assert.equal(
      page.indexOf("这份文件里会有别人说的话") < page.indexOf("<DataExportPanel"),
      true,
    );
  });

  it("三种状态都有，而且失败时原样显示服务端那句话", () => {
    const panel = strip(src("components/me/DataExportPanel.tsx"));
    assert.match(panel, /"idle" \| "working" \| "done" \| "error"/);
    assert.match(panel, /aria-live="polite"/);
    // 换成一句「导出失败，请重试」的话，用户会立刻再点一次，
    // 而他要做的恰恰是等一会儿
    assert.match(panel, /const text = await response\.text\(\)/);
  });

  it("按钮够大，手机上点得中", () => {
    // 44pt 是能稳定点中的下限；min-h-11 = 44px
    assert.match(strip(src("components/me/DataExportPanel.tsx")), /min-h-11/);
  });

  it("这一页没有跨 RSC 边界传函数 —— 传了线上就是 500", () => {
    const page = src("app/(app)/me/export/page.tsx");
    assert.equal(/<DataExportPanel[^>]*=\{\s*(async\s*)?\(/.test(page), false);
    assert.match(page, /<DataExportPanel willTruncate=\{preview\.willTruncate\} \/>/);
  });
});
