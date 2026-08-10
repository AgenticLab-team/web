import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateChoices } from "@/lib/forum/poll-choice";
import { readCode } from "./_source";

/**
 * 投票时提交上来的选项要收拾成什么样。
 *
 * ─────────────────────────────────────────
 * 这条测试是变异普查逼出来的
 * ─────────────────────────────────────────
 *
 * `polls.ts` 里那句
 * `[...new Set(input.optionIds)].filter((id) => validOptions.includes(id))`
 * 改成恒真之后，**全量测试一条都不红**。
 *
 * 而选项 id 是**客户端送上来的**。不对回这个投票自己的选项表的话，
 * 一次请求就能给**别的投票**的选项加票 ——
 * `poll_votes` 里会出现 pollId 是这一个、optionId 是那一个的行，
 * 而那个投票的票数被一群从没看过它的人抬上去。
 *
 * 那种脏数据没有任何地方会报错：票数就是比实际多几票，
 * 而没有人能说清多的是哪几票。
 */

const call = (submitted: string[], validIds: string[], multi = false) =>
  validateChoices({ submitted, validIds, multi });

describe("选项校验", () => {
  it("正常单选", () => {
    const r = call(["a"], ["a", "b"]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.chosen, ["a"]);
    assert.equal(r.error, null);
  });

  it("**不属于这个投票的选项被丢掉**", () => {
    /*
     * 这一条是整个文件存在的理由：留着的话，
     * 别的投票的票数会被一群从没看过它的人抬上去。
     */
    const r = call(["a", "别人家的选项"], ["a", "b"], true);
    assert.equal(r.ok, true);
    assert.deepEqual(r.chosen, ["a"], "外来的选项混进了要落库的那一批");
  });

  it("**全都不属于这个投票 → 拒绝**", () => {
    const r = call(["外来1", "外来2"], ["a", "b"], true);
    assert.equal(r.ok, false);
    assert.deepEqual(r.chosen, []);
  });

  it("**错误信息不透露「那个 id 存在，只是不在这儿」**", () => {
    /*
     * 分开说的话等于给人一个试探接口 —— 选项 id 是 ULID，
     * 本来就不该让人从错误信息里试出来。
     * 所以「提交了非法选项」和「什么都没提交」给同一句话。
     */
    const foreign = call(["外来的"], ["a"]);
    const empty = call([], ["a"]);
    assert.equal(foreign.error, empty.error);
    assert.equal(foreign.error, "请选择一个选项");
  });

  it("重复提交同一个选项只算一票", () => {
    const r = call(["a", "a", "a"], ["a", "b"]);
    assert.deepEqual(r.chosen, ["a"]);
  });

  it("**去重之后才判单选** —— 「a,a」不该被当成选了两个", () => {
    const r = call(["a", "a"], ["a", "b"], false);
    assert.equal(r.ok, true, "同一个选项提交两次被误判成多选了");
  });

  it("单选投票里选了两个 → 拒绝", () => {
    const r = call(["a", "b"], ["a", "b"], false);
    assert.equal(r.ok, false);
    assert.equal(r.error, "这是单选投票");
  });

  it("多选投票里选两个是可以的", () => {
    const r = call(["a", "b"], ["a", "b"], true);
    assert.equal(r.ok, true);
    assert.deepEqual(r.chosen.sort(), ["a", "b"]);
  });

  it("什么都没提交 → 拒绝", () => {
    assert.equal(call([], ["a"]).ok, false);
  });

  it("**拒绝时 chosen 一定是空的** —— 免得调用方拿着它去落库", () => {
    for (const r of [call([], ["a"]), call(["a", "b"], ["a", "b"], false)]) {
      assert.deepEqual(r.chosen, []);
    }
  });

  it("这个投票一个选项都没有时，什么也投不了", () => {
    assert.equal(call(["a"], []).ok, false);
  });
});

describe("**接线：投票时真的调它**", () => {
  const polls = readCode("lib/forum/polls.ts");

  it("castVote 用的是 validateChoices", () => {
    assert.match(polls, /const verdict = validateChoices\(\{/);
    assert.match(polls, /if \(!verdict\.ok\) return fail\(verdict\.error!\)/);
  });

  it("**不再自己筛一遍** —— 两处判定迟早分叉", () => {
    assert.equal(
      polls.includes("validOptions.includes"),
      false,
      "polls.ts 里又出现了自己筛选项的代码",
    );
  });

  it("**校验排在写票之前**", () => {
    /*
     * 排在后面的话，票已经记进去了才发现不合法 ——
     * 而 poll_options.votes 是加过的，撤不干净。
     */
    /*
     * 只在 castVote 这一段里找 —— 文件里有三处 db.transaction(，
     * 拿全文 indexOf 会撞上 createPoll 里的那个，
     * 于是这条断言测的是别的函数的顺序。
     */
    const fn = polls.slice(polls.indexOf("export async function castVote"));
    const at = fn.indexOf("validateChoices(");
    const write = fn.indexOf("db.transaction(");
    assert.ok(at > 0 && write > 0);
    assert.ok(at < write, "选项校验跑在写票后面了");
  });
});
