import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  MAX_PER_IP_PER_DAY,
  MIN_REASON_CHARS,
  SUBMITTED_MESSAGE,
  checkJoinRequest,
  checkRate,
  judgeApplicant,
} from "@/lib/join/rules";

/**
 * 申请加入社群。
 *
 * ─────────────────────────────────────────
 * 这是全站唯一一个「陌生人能写」的入口
 * ─────────────────────────────────────────
 *
 * 别的地方都要先登录，而登录要先是群成员。这一页不行 ——
 * 想加入的人按定义还不是成员。
 *
 * 于是它同时是这个站唯一的垃圾投放面和信息泄露面，
 * 这一组测试基本都在测后者。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

describe("**不能变成「这个微信号是不是成员」的查询接口**", () => {
  it("提交之后的回话只有一句，不按情况分支", () => {
    /*
     * 最容易犯的错是给友好的反馈：
     *   「你已经是成员了，直接登录吧」
     *   「你已经申请过了，请耐心等待」
     *
     * 两句都很体贴，而且都在回答一个陌生人不该能问的问题。
     * 一个个试就能把整份成员名单摸出来。
     */
    assert.ok(SUBMITTED_MESSAGE.length > 0);
    assert.doesNotMatch(SUBMITTED_MESSAGE, /已经是成员|已经申请过|不在群里/);
  });

  it("**提交那条路径根本不查成员身份** —— 查了就会想说出来", () => {
    const code = src("lib/join/actions.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*/g, "");
    const submit = code.slice(code.indexOf("function submitJoinRequest"), code.indexOf("function handleJoinRequest"));

    for (const leak of ["applicantActivity", "boundAccountOf", "groupMembers", "judgeApplicant"]) {
      assert.ok(!submit.includes(leak), `提交路径里查了 ${leak}`);
    }
  });

  it("**表里不做唯一约束** —— 第二次提交失败等于确认「这个号申请过」", () => {
    const schema = src("lib/db/schema/join.ts");
    assert.doesNotMatch(schema, /uniqueIndex/);
  });

  it("被限流时的话也不能透露别人的申请情况", () => {
    const v = checkRate(Array.from({ length: MAX_PER_IP_PER_DAY }, () => Date.now()), Date.now());
    assert.equal(v.allowed, false);
    assert.doesNotMatch(v.message, /已经|成员|申请过/);
  });
});

describe("校验只拦「填错了」", () => {
  const good = { wxId: "wxid_abc", reason: "在群里看到有人转了这个站，想进来看看沉淀的内容" };

  it("正常的通过", () => {
    const r = checkJoinRequest(good);
    assert.equal(r.ok, true);
  });

  it("没填微信号 —— 拒，并说清楚为什么要", () => {
    const r = checkJoinRequest({ ...good, wxId: "  " });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /群里找不到你/);
  });

  it("理由太短 —— 拒", () => {
    const r = checkJoinRequest({ ...good, reason: "想进" });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, new RegExp(String(MIN_REASON_CHARS)));
  });

  it("**不校验微信号格式** —— 规则变过几次，按格式拦的第一个多半是真人", () => {
    /*
     * 微信号可以是自设 ID、也可以是 wxid_ 开头的原始号。
     * 而管理员核对时本来就要人工看一眼。
     */
    for (const wxId of ["wxid_abc123", "my-custom-id", "A_B.c", "张三"]) {
      assert.equal(checkJoinRequest({ ...good, wxId }).ok, true, `${wxId} 被格式拦了`);
    }
  });

  it("压平换行 —— 管理员那边是一行行看的", () => {
    const r = checkJoinRequest({ ...good, reason: "第一行\n\n\n第二行，凑够十个字符" });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.doesNotMatch(r.reason, /\n/);
  });

  it("过长的截断，不整个拒", () => {
    const r = checkJoinRequest({ ...good, reason: "长".repeat(1000) });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.ok(r.reason.length <= 300);
  });

  it("联系方式可选，空的是 null", () => {
    const r = checkJoinRequest({ ...good, contact: "   " });
    assert.equal(r.ok && r.contact, null);
  });
});

describe("限流", () => {
  const NOW = 1_700_000_000_000;

  it("没提交过的放行", () => {
    assert.equal(checkRate([], NOW).allowed, true);
  });

  it("**一天有上限** —— 这是全站唯一陌生人能写的入口", () => {
    const times = Array.from({ length: MAX_PER_IP_PER_DAY }, () => NOW - 1000);
    assert.equal(checkRate(times, NOW).allowed, false);
  });

  it("24 小时之外的不算 —— 滚动窗口，不是自然日", () => {
    const old = Array.from({ length: MAX_PER_IP_PER_DAY }, () => NOW - 86_400_001);
    assert.equal(checkRate(old, NOW).allowed, true);
  });

  it("上限定得低但不至于挡住正常人 —— 一个人不会一天填五次", () => {
    assert.ok(MAX_PER_IP_PER_DAY >= 3 && MAX_PER_IP_PER_DAY <= 10);
  });
});

describe("**判断在管理员那一侧**", () => {
  it("已经有账号 —— 提示去绑定审批看看", () => {
    const s = judgeApplicant({ groups: ["群A"], hasAccount: true });
    assert.equal(s.kind, "already_member");
    assert.match(s.detail, /绑定审批/);
  });

  it("在群里但没账号 —— 让他自己发验证码就行，不用再拉一次", () => {
    const s = judgeApplicant({ groups: ["群A", "群B"], hasAccount: false });
    assert.equal(s.kind, "in_group");
    assert.match(s.detail, /群A、群B/);
    assert.match(s.detail, /不需要再拉/);
  });

  it("不在任何群里 —— 说清楚要先拉进群", () => {
    const s = judgeApplicant({ groups: [], hasAccount: false });
    assert.equal(s.kind, "outsider");
    assert.match(s.detail, /入口只有群/);
  });

  it("规则层不碰数据库", () => {
    const code = src("lib/join/rules.ts");
    for (const forbidden of ["server-only", "@/lib/db", "drizzle-orm"]) {
      assert.equal(code.includes(forbidden), false, `规则层引了 ${forbidden}`);
    }
  });
});

describe("处理动作", () => {
  const code = src("lib/join/actions.ts");

  it("**处理不产生任何账号** —— 这个站的入口只有群", () => {
    const fn = code.slice(code.indexOf("function handleJoinRequest"));
    assert.doesNotMatch(fn.slice(0, 1500), /insert\(users\)|createSession|insert\(credentials\)/);
  });

  it("处理要走 requireWritableAdmin 并记审计", () => {
    const fn = code.slice(code.indexOf("function handleJoinRequest"));
    assert.match(fn.slice(0, 400), /requireWritableAdmin\("user\.bind\.approve"\)/);
    assert.match(fn, /audit\(/);
  });

  it("处理过的不能再处理一次", () => {
    const fn = code.slice(code.indexOf("function handleJoinRequest"));
    assert.match(fn, /row\.status !== "pending"/);
  });

  it("**提交不需要登录** —— 想加入的人按定义还不是成员", () => {
    const fn = code.slice(code.indexOf("function submitJoinRequest"), code.indexOf("function handleJoinRequest"));
    assert.doesNotMatch(fn, /requireAdmin|getCurrentUser/);
  });
});

describe("界面", () => {
  const page = src("app/join/page.tsx");
  const form = src("components/join/JoinForm.tsx");
  const queue = src("components/admin/JoinQueue.tsx");

  it("**说清楚为什么没有注册按钮** —— 不解释的话人会以为是 bug", () => {
    /*
     * 一个没有注册入口的站，默认观感是「做得不完整」。
     * 而这里是刻意的：账号跟着群成员身份走。
     */
    assert.match(page, /账号跟着群成员身份走/);
  });

  it("已经在群里的人被引导去登录，而不是填这张表", () => {
    assert.match(page, /已经在群里/);
    assert.match(page, /href="\/login"/);
  });

  it("**这一页不在 (app) 外壳里** —— 给陌生人看一排点不动的入口更难受", () => {
    // 路径在 src/app/join 而不是 src/app/(app)/join
    assert.match(page, /export default function JoinPage/);
    assert.match(page, /<main/);
  });

  it("**提交成功之后收起表单** —— 留着的话人会因为不确定而再点几次", () => {
    assert.match(form, /if \(done\) \{/);
  });

  it("当场告诉人还差多少字", () => {
    assert.match(form, /还差 \$\{MIN_REASON_CHARS - reason\.trim\(\)\.length\} 个字/);
  });

  it("后台队列把依据排在按钮前面", () => {
    const detailAt = queue.indexOf("standing.detail");
    const buttonAt = queue.indexOf('onClick={() => run(row.id, "handled")}');
    assert.ok(detailAt > 0 && buttonAt > 0 && detailAt < buttonAt);
  });

  it("后台明说「标记不产生账号」", () => {
    assert.match(queue, /不会产生任何账号/);
  });

  it("**登录页给还不是成员的人一条路**", () => {
    /*
     * 那一页所有的路都假设你已经在群里 —— 一个不在群里的人
     * 走到那里只会反复取验证码然后发现没地方发。
     */
    assert.match(src("app/login/page.tsx"), /href="\/join"/);
  });

  it("首页的登录引导旁边也有", () => {
    assert.match(src("app/(app)/page.tsx"), /href="\/join"/);
  });
});
