import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  ACCEPT_DAILY_CAP,
  ACCEPT_MIN_GAP_MS,
  DAY_MS,
  QUIET_MESSAGE_THRESHOLD,
  STALE_BIND_MS,
  STUCK_CODE_THRESHOLD,
  acceptBudget,
  canManualBind,
  groupStuck,
  isActionable,
  judgeApplicant,
  type ApplicantActivity,
} from "@/lib/auth/bind-queue";

/**
 * 绑定审批队列。
 *
 * 这个队列要回答的只有一个问题:**「这个人是不是真的在我们群里」**。
 * 整站的入口规则就一条 —— 只有群成员能登录。
 * 而人工审批是绕过验证码那个证明的一条路,所以它得自己把证明补回来。
 */

const NOW = Date.UTC(2026, 7, 8, 12);

const activity = (o: Partial<ApplicantActivity> = {}): ApplicantActivity => ({
  groups: ["AI 实验室"],
  messages: 100,
  lastSeenAt: NOW - 3600_000,
  joinedAt: NOW - 90 * DAY_MS,
  ...o,
});

describe("**好友申请的额度只算账、不拦**", () => {
  it("没通过过的时候可以通过", () => {
    const b = acceptBudget([], NOW);
    assert.equal(b.remaining, ACCEPT_DAILY_CAP);
    assert.equal(b.waitMs, 0);
  });

  it("数得出今天通过了几个 —— 风控是真的，人得看见数字", () => {
    const times = Array.from({ length: ACCEPT_DAILY_CAP }, (_, i) => NOW - i * 3600_000);
    const b = acceptBudget(times, NOW);
    assert.equal(b.remaining, 0);
    assert.match(b.reason, /风控/);
  });

  it("间隔太密时提示出来", () => {
    const b = acceptBudget([NOW - 60_000], NOW);
    assert.equal(b.remaining > 0, true);
    assert.ok(b.waitMs > 0);
    assert.match(b.reason, /风控/, "提示里没说清楚为什么要悠着点");
  });

  it("隔够了就放行", () => {
    const b = acceptBudget([NOW - ACCEPT_MIN_GAP_MS - 1], NOW);
    assert.equal(b.waitMs, 0);
  });

  it("**超过 24 小时的不算数** —— 额度是滚动的，不是自然日", () => {
    const old = Array.from({ length: ACCEPT_DAILY_CAP }, () => NOW - DAY_MS - 1000);
    const b = acceptBudget(old, NOW);
    assert.equal(b.remaining, ACCEPT_DAILY_CAP);
    assert.equal(b.usedToday, 0);
  });

  it("额度用完时说得出还要等多久", () => {
    const times = Array.from({ length: ACCEPT_DAILY_CAP }, (_, i) => NOW - i * 3600_000);
    const b = acceptBudget(times, NOW);
    assert.ok(b.waitMs > 0);
  });

  it("传进来的顺序不影响结果", () => {
    const times = [NOW - 3 * 3600_000, NOW - 60_000, NOW - 2 * 3600_000];
    const a = acceptBudget(times, NOW);
    const b = acceptBudget([...times].reverse(), NOW);
    assert.deepEqual(a, b);
  });

  it("参考值定得保守 —— 它是给人看的判断依据", () => {
    assert.ok(ACCEPT_DAILY_CAP <= 10, `一天 ${ACCEPT_DAILY_CAP} 个作为提示门槛太宽了`);
    assert.ok(ACCEPT_MIN_GAP_MS >= 60_000);
  });
});

describe("申请人活跃度", () => {
  it("**不在任何群里 —— 说清楚通过他意味着什么**", () => {
    const v = judgeApplicant(activity({ groups: [] }), NOW);
    assert.equal(v.kind, "stranger");
    assert.match(v.detail, /站外/);
  });

  it("在群里、说过话 —— 活跃成员", () => {
    const v = judgeApplicant(activity(), NOW);
    assert.equal(v.kind, "member");
    assert.match(v.detail, /AI 实验室/);
    assert.match(v.detail, /100 条/);
  });

  it("**在群里但潜水 —— 不当成可疑**", () => {
    /*
     * 潜水的人很多,这不是坏事。
     * 把潜水判成可疑的话,审批的人会开始默认拒绝,
     * 而那正好把这个功能变成一道无法通过的门。
     */
    const v = judgeApplicant(activity({ messages: 2 }), NOW);
    assert.equal(v.kind, "lurker");
    assert.match(v.detail, /不代表有问题/);
  });

  it("刚好到门槛就算活跃", () => {
    assert.equal(judgeApplicant(activity({ messages: QUIET_MESSAGE_THRESHOLD }), NOW).kind, "member");
    assert.equal(
      judgeApplicant(activity({ messages: QUIET_MESSAGE_THRESHOLD - 1 }), NOW).kind,
      "lurker",
    );
  });

  it("说得出最后一次说话是多久以前", () => {
    const v = judgeApplicant(activity({ lastSeenAt: NOW - 5 * DAY_MS }), NOW);
    assert.match(v.detail, /5 天前/);
  });

  it("今天说过话就说今天", () => {
    const v = judgeApplicant(activity({ lastSeenAt: NOW - 3600_000 }), NOW);
    assert.match(v.detail, /今天/);
  });

  it("从没说过话也不炸", () => {
    const v = judgeApplicant(activity({ lastSeenAt: null }), NOW);
    assert.ok(v.detail.length > 0);
  });

  it("**三档而不是打分** —— 打分会让人只看数字不看依据", () => {
    /*
     * 这里真正要传达的是「他在不在群里」这个是非题,
     * 而一个 73 分没法回答是非题。
     */
    const src = readFileSync(new URL("../src/lib/auth/bind-queue.ts", import.meta.url), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
    assert.doesNotMatch(code, /score|评分|\bpoints\b/i);
  });
});

describe("**手动绑定要把群成员这个证明补回来**", () => {
  const base = { alreadyBoundTo: null, reason: "他在群里问了三次，码一直匹配不上" };

  it("不在任何群里 —— 硬拒，没有例外", () => {
    /*
     * 留了例外的话,「只有群成员能登录」的实际含义就变成
     * 「只有群成员、或者某个管理员愿意点通过的人能登录」,
     * 那前半句就不再是一条规则,只是一个默认值。
     */
    const r = canManualBind({ ...base, activity: activity({ groups: [] }) });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /只有群成员能登录/);
  });

  it("在群里就放行", () => {
    assert.equal(canManualBind({ ...base, activity: activity() }).ok, true);
  });

  it("**潜水的人也放行** —— 门槛是「在不在群里」，不是「活跃不活跃」", () => {
    assert.equal(canManualBind({ ...base, activity: activity({ messages: 0 }) }).ok, true);
  });

  it("已经绑给别人的微信号不能再绑", () => {
    const r = canManualBind({ ...base, activity: activity(), alreadyBoundTo: "01USER..." });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /已经绑/);
  });

  it("**必填理由** —— 它绕过了验证码，事后要说得清", () => {
    const r = canManualBind({ ...base, activity: activity(), reason: "嗯" });
    assert.equal(r.ok, false);
  });

  it("空白理由不算数", () => {
    assert.equal(canManualBind({ ...base, activity: activity(), reason: "      " }).ok, false);
  });
});

describe("队列不能越堆越长", () => {
  it("一天以内的才处理", () => {
    assert.equal(isActionable(NOW - 3600_000, NOW), true);
    assert.equal(isActionable(NOW - STALE_BIND_MS - 1, NOW), false);
  });

  it("门槛是 24 小时 —— 更早的人多半早就重试成功或者放弃了", () => {
    assert.equal(STALE_BIND_MS, DAY_MS);
  });
});

describe("规则层不碰 IO", () => {
  it("纯函数", () => {
    // 去注释再查 —— 说明文字里提到 nekobot 是正常的，import 才不正常
    const src = readFileSync(new URL("../src/lib/auth/bind-queue.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*/g, "");
    for (const forbidden of ["server-only", "@/lib/db", "drizzle-orm", "nekobot"]) {
      assert.equal(src.includes(forbidden), false, `规则层引了 ${forbidden}`);
    }
  });
});

describe("接线", () => {
  const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

  it("**服务端不再拦** —— 站长要求管理接口不设限速", () => {
    /*
     * 这条是方向锁:防止以后有人「顺手」把限速加回来。
     * 风控的判断交给人,前提是数字看得见 —— 见下一条。
     */
    const code = strip(src("lib/auth/bind-queue-actions.ts"));
    const fn = code.slice(
      code.indexOf("function acceptFriendRequestAction"),
      code.indexOf("function manualBindAction"),
    );
    assert.doesNotMatch(fn, /return fail\(budget/, "限速拦截被加回来了");
    assert.doesNotMatch(fn, /waitMs > 0/, "限速拦截被加回来了");
  });

  it("**但通过之后要回显今天的累计** —— 不拦了，人就得看得见", () => {
    const code = strip(src("lib/auth/bind-queue-actions.ts"));
    const fn = code.slice(
      code.indexOf("function acceptFriendRequestAction"),
      code.indexOf("function manualBindAction"),
    );
    assert.match(fn, /currentAcceptBudget\(\)/, "连点的人看不到自己点了几下");
  });

  it("**上游失败不记审计** —— 记了的话失败的尝试会白白吃掉今天的额度", () => {
    const code = strip(src("lib/auth/bind-queue-actions.ts"));
    const fn = code.slice(
      code.indexOf("function acceptFriendRequestAction"),
      code.indexOf("function manualBindAction"),
    );
    const catchAt = fn.indexOf("catch");
    const auditAt = fn.indexOf("audit(");
    assert.ok(catchAt < auditAt, "审计写在 catch 之前");
    // catch 块里应当直接 return，不落审计
    const catchBlock = fn.slice(catchAt, auditAt);
    assert.doesNotMatch(catchBlock, /audit\(/);
  });

  it("**手动绑定查 canManualBind** —— 那是入口规则的最后一道", () => {
    const code = strip(src("lib/auth/bind-queue-actions.ts"));
    const fn = code.slice(code.indexOf("function manualBindAction"));
    assert.match(fn.slice(0, 900), /canManualBind\(/);
  });

  it("**过期的码不放行** —— 别把过期的码手动放过去", () => {
    const code = strip(src("lib/auth/bind-queue-actions.ts"));
    const fn = code.slice(code.indexOf("function manualBindAction"));
    assert.match(fn.slice(0, 1400), /expiresAt < now/);
  });

  it("三个 action 都走 requireWritableAdmin", () => {
    const code = strip(src("lib/auth/bind-queue-actions.ts"));
    for (const fn of ["acceptFriendRequestAction", "manualBindAction", "dismissBindAction"]) {
      const body = code.slice(code.indexOf(`function ${fn}`));
      assert.match(body.slice(0, 300), /requireWritableAdmin\(/, `${fn} 没走守卫`);
    }
  });

  it("**用上了那两个一直没人读的权限点**", () => {
    /*
     * user.bind.approve 和 user.bind.manual 在权限表里躺了很久,
     * 一个调用点都没有 —— 又是「声明了但没接上」。
     */
    const code = src("lib/auth/bind-queue-actions.ts");
    assert.match(code, /"user\.bind\.approve"/);
    assert.match(code, /"user\.bind\.manual"/);
  });

  it("**上游挂了不显示成「没有待处理的申请」** —— 那会让人以为处理完了", () => {
    const code = strip(src("lib/auth/bind-queue-queries.ts"));
    const fn = code.slice(code.indexOf("function pendingFriendRequests"));
    assert.match(fn.slice(0, 800), /error: `拉不到好友申请列表/);
  });

  it("退了群的人不算群成员", () => {
    const code = strip(src("lib/auth/bind-queue-queries.ts"));
    const fn = code.slice(code.indexOf("function applicantActivity"));
    assert.match(fn.slice(0, 700), /isNull\(groupMembers\.leftAt\)/);
  });
});

describe("**门槛是量出来的，不是拍的**", () => {
  it("取过一次不算卡住 —— 打开登录页就会取一个码", () => {
    const rows = [
      { id: "a", code: "1", issuedIp: "1.1.1.1", createdAt: 100, expiresAt: 400, matched: false },
      { id: "b", code: "2", issuedIp: "2.2.2.2", createdAt: 200, expiresAt: 500, matched: false },
    ];
    assert.deepEqual(groupStuck(rows), []);
  });

  it("取过两次才算", () => {
    const rows = [
      { id: "a", code: "1", issuedIp: "1.1.1.1", createdAt: 100, expiresAt: 400, matched: false },
      { id: "b", code: "2", issuedIp: "1.1.1.1", createdAt: 200, expiresAt: 500, matched: false },
    ];
    const out = groupStuck(rows);
    assert.equal(out.length, 1);
    assert.equal(out[0].codes, 2);
  });

  it("**要处理的是最近那个码** —— 早的那个多半已经过期了", () => {
    const rows = [
      { id: "old", code: "1", issuedIp: "1.1.1.1", createdAt: 100, expiresAt: 200, matched: false },
      { id: "new", code: "2", issuedIp: "1.1.1.1", createdAt: 900, expiresAt: 1200, matched: false },
    ];
    const out = groupStuck(rows);
    assert.equal(out[0].latestCodeId, "new");
    assert.equal(out[0].latestCode, "2");
    assert.equal(out[0].firstAt, 100);
    assert.equal(out[0].lastAt, 900);
  });

  it("传进来的顺序不影响结果", () => {
    const rows = [
      { id: "a", code: "1", issuedIp: "1.1.1.1", createdAt: 100, expiresAt: 400, matched: false },
      { id: "b", code: "2", issuedIp: "1.1.1.1", createdAt: 900, expiresAt: 1200, matched: false },
    ];
    assert.deepEqual(groupStuck(rows), groupStuck([...rows].reverse()));
  });

  it("没有 IP 的记录跳过 —— 认不出是谁就聚不起来", () => {
    const rows = [
      { id: "a", code: "1", issuedIp: null, createdAt: 100, expiresAt: 400, matched: false },
      { id: "b", code: "2", issuedIp: null, createdAt: 200, expiresAt: 500, matched: false },
    ];
    assert.deepEqual(groupStuck(rows), []);
  });

  it("试得最多的排最前", () => {
    const rows = [
      { id: "a1", code: "1", issuedIp: "1.1.1.1", createdAt: 100, expiresAt: 400, matched: false },
      { id: "a2", code: "2", issuedIp: "1.1.1.1", createdAt: 200, expiresAt: 500, matched: false },
      { id: "b1", code: "3", issuedIp: "2.2.2.2", createdAt: 300, expiresAt: 600, matched: false },
      { id: "b2", code: "4", issuedIp: "2.2.2.2", createdAt: 400, expiresAt: 700, matched: false },
      { id: "b3", code: "5", issuedIp: "2.2.2.2", createdAt: 500, expiresAt: 800, matched: false },
    ];
    const out = groupStuck(rows);
    assert.equal(out[0].ip, "2.2.2.2");
    assert.equal(out[0].codes, 3);
  });

  it("门槛定在 2 —— 定在 1 的话队列每天两百多条", () => {
    assert.equal(STUCK_CODE_THRESHOLD, 2);
  });

  it("**后来成功了的人整个排掉** —— 他早就登录进去了", () => {
    /*
     * 第一版只按「这个码没匹配上」过滤,于是一个取了 5 次、
     * 第 5 次终于进去的人,还剩 4 条没匹配的记录 ——
     * 队列上写着「取了 4 次码」。
     *
     * 上线之后对着生产数一遍才发现:预期 12 条，实际 49 条。
     * 一个让人去联系已经登录成功的人的队列，比没有队列更浪费时间。
     */
    const rows = [
      { id: "a", code: "1", issuedIp: "1.1.1.1", createdAt: 100, expiresAt: 400, matched: false },
      { id: "b", code: "2", issuedIp: "1.1.1.1", createdAt: 200, expiresAt: 500, matched: false },
      { id: "c", code: "3", issuedIp: "1.1.1.1", createdAt: 300, expiresAt: 600, matched: false },
      { id: "d", code: "4", issuedIp: "1.1.1.1", createdAt: 400, expiresAt: 700, matched: true },
    ];
    assert.deepEqual(groupStuck(rows), [], "他第 4 次就进去了，还被当成卡住的人");
  });

  it("成功的那次不算进「取了几次」", () => {
    const rows = [
      { id: "a", code: "1", issuedIp: "1.1.1.1", createdAt: 100, expiresAt: 400, matched: false },
      { id: "b", code: "2", issuedIp: "1.1.1.1", createdAt: 200, expiresAt: 500, matched: false },
      { id: "c", code: "3", issuedIp: "2.2.2.2", createdAt: 300, expiresAt: 600, matched: true },
      { id: "d", code: "4", issuedIp: "2.2.2.2", createdAt: 400, expiresAt: 700, matched: false },
    ];
    const out = groupStuck(rows);
    assert.equal(out.length, 1);
    assert.equal(out[0].ip, "1.1.1.1");
  });
});
