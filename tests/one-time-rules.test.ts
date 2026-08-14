import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { repoRoot, walkSource } from "./_source";

/**
 * 「一次性」规则在注销面前还成不成立。
 *
 * ─────────────────────────────────────────
 * 注销打破了一个到处都在用的隐含前提
 * ─────────────────────────────────────────
 *
 * 这个站里大量规则按 `user_id` 判「这个人有没有领过」。
 * 在没有注销功能的时候，那**等价于**按人判 —— 一个人一个 user_id，
 * 一辈子不变。
 *
 * 做出注销之后就不等价了：注销 → 重新绑定同一个微信 →
 * 拿到一个全新的 user_id → 所有按 user_id 判的「领过没有」全部归零。
 *
 * 邀请奖励就是这么被打开的（见 delete-rebind.test.ts）——
 * 而那条规则**自己的注释**早就写着「注销重注册就能反复领」，
 * 只是当时站里还没有注销这回事。
 *
 * ─────────────────────────────────────────
 * 所以每加一个付款点，都要重新问一遍
 * ─────────────────────────────────────────
 *
 * 这份清单钉住所有 `grantPoints` 的调用点。加一个新的就会红 ——
 * 红的时候要回答的问题只有一个：
 * **这个人注销重绑之后，这笔钱会不会再付一次。**
 */

const PAYOUTS: Record<string, { key: string; safeAfterDelete: boolean; why: string }> = {
  "lib/invites/settle.ts": {
    key: "invite:<inviteUse.id>",
    safeAfterDelete: true,
    why:
      "invite_uses 是 keep 档，行不会被清，幂等键因此还在。" +
      "而「能不能再被邀请一次」那一层已经改成顺着 prior_wx_id 查历史账号",
  },
  "lib/forum/qa.ts": {
    key: "bounty-award:<post.id>",
    safeAfterDelete: true,
    why:
      "键挂在帖子上，而 forum_posts 是抹名字不是删行 —— 重绑之后那篇提问还在，键也还在。" +
      "（原来挂在回复上，注销这一层同样安全，但那样「换一个采纳对象」就能再付一次全额）",
  },
  "lib/titles/settle.ts": {
    key: "title-renew:<userTitle.id>:<expiresAt>",
    safeAfterDelete: true,
    why: "user_titles 会被清，但续期只对已有的称号发生，重绑的新账号一个称号都没有",
  },
  "lib/points/checkin.ts": {
    key: "checkin:<user.id>:<today>",
    safeAfterDelete: false,
    why:
      "**键里带 user.id，重绑会拿到新的** —— 理论上「今天打过卡 → 注销 → 重绑 → 再打一次」" +
      "能多领一份。不修，因为这笔账反过来了：打卡一次 10 分，而注销要付出全部积分、" +
      "称号、连胜、收藏、草稿。**代价远大于收益的漏洞不是漏洞**，" +
      "为它把打卡改成按 wx_id 判反而会引出真问题（一个人两个账号同一天打卡怎么算）。" +
      "记在这里，是为了下一个人不用再推一遍",
  },
  "lib/titles/actions.ts": {
    key: "（购买，扣分不是发分）",
    safeAfterDelete: true,
    why: "这是花钱不是发钱，重复只会让人多花，不构成刷分",
  },
  "lib/shop/purchase.ts": {
    key: "（下单，扣分不是发分）",
    safeAfterDelete: true,
    why: "商店下单同样是扣分。而且订单是 keep 档 —— 已经发生的兑换是事实，重绑不会把它抹掉",
  },
  "lib/admin/user-actions.ts": {
    key: "（管理员手工调整）",
    safeAfterDelete: true,
    why: "人工操作，每一次都有审计和理由，不是自动发放",
  },
};

function payoutSites(): string[] {
  const found = new Set<string>();
  for (const file of walkSource(join(repoRoot, "src/lib"))) {
    if (file.endsWith("points/ledger.ts")) continue;
    if (!readFileSync(file, "utf8").includes("grantPoints(")) continue;
    found.add(file.slice(join(repoRoot, "src/").length));
  }
  return [...found].sort();
}

describe("**每个发分的地方都想过注销这件事**", () => {
  const sites = payoutSites();

  it("扫描没坏 —— 真的找到了一批调用点", () => {
    assert.ok(sites.length >= 5, `只扫出 ${sites.length} 处，八成是路径或关键字变了`);
  });

  it("**清单和代码对得上** —— 新加一个付款点就会红", () => {
    /*
     * 红了要回答的问题只有一个：这个人注销重绑之后，
     * 这笔钱会不会再付一次。
     *
     * 想清楚了就往 PAYOUTS 里补一条，连同理由。
     */
    assert.deepEqual(
      sites,
      Object.keys(PAYOUTS).sort(),
      "发分的地方变了 —— 新增的那个在注销重绑之后会不会重复发？想清楚再往 PAYOUTS 里补",
    );
  });

  it("**每一条都写得出为什么**", () => {
    for (const [site, p] of Object.entries(PAYOUTS)) {
      assert.ok(p.why.length > 20, `${site} 的理由太短`);
    }
  });

  it("**不安全的那些必须写明为什么不修**", () => {
    /*
     * 「知道有问题但不修」和「没想到」在代码里长得一模一样。
     * 前者要留下判断依据，否则下一个人只能重新推一遍 ——
     * 或者更糟：以为是疏漏，去「修」它。
     */
    for (const [site, p] of Object.entries(PAYOUTS)) {
      if (p.safeAfterDelete) continue;
      assert.match(p.why, /不修|代价|收益/, `${site} 标着不安全，却没说为什么不修`);
    }
  });
});

describe("**幂等键确实在代码里**", () => {
  it("邀请、悬赏、续期、打卡各自的键没被改掉", () => {
    /*
     * 上面那张表是人写的，可能和代码分叉。这一条把几个关键的键
     * 拿回代码里对一遍 —— 键一旦变了，上面的推理就不成立了。
     */
    const checks: [string, RegExp][] = [
      ["lib/invites/settle.ts", /idempotencyKey: `invite:\$\{use\.id\}`/],
      // 悬赏的键只在 bountyAwardKey 里定义一次，调用点引用它 —— 所以对的是定义
      ["lib/forum/qa.ts", /function bountyAwardKey\(postId: string\): string \{\s*\n\s*return `bounty-award:\$\{postId\}`;/],
      ["lib/points/checkin.ts", /idempotencyKey: `checkin:\$\{user\.id\}:\$\{today\}`/],
    ];
    for (const [file, pattern] of checks) {
      const body = readFileSync(join(repoRoot, "src", file), "utf8");
      assert.match(body, pattern, `${file} 的幂等键变了 —— PAYOUTS 里的判断要重新过一遍`);
    }
  });
});

describe("**一笔悬赏只结算一次**", () => {
  /*
   * ═════════════════════════════════════════
   * 「采纳 A → 取消 → 采纳 B」曾经能付两次全额
   * ═════════════════════════════════════════
   *
   * 幂等键当时挂在**回复**上，而撤销采纳既不清零悬赏也不冲正。
   * 于是同一笔悬赏付给了两个人，提问者只被扣过一次 ——
   * 而且可以对 C、D…… 无限重复。积分流水是这个站唯一的硬通货，
   * 那是凭空增发。
   *
   * 堵法有两头，缺一不可，所以这里分两条断言：
   *   · 键挂在帖子上 —— 换个采纳对象也是同一个键，发不出第二次；
   *   · 结算过之后不许再追加悬赏 —— 否则那笔钱会照常扣走，
   *     而下一次采纳撞上幂等键发不出去，分反过来蒸发。
   */
  const qa = readFileSync(join(repoRoot, "src/lib/forum/qa.ts"), "utf8");

  it("键挂在帖子上，不是挂在回复上", () => {
    assert.match(qa, /idempotencyKey: bountyAwardKey\(post\.id\)/);
    assert.doesNotMatch(
      qa,
      /idempotencyKey: `bounty-award:\$\{reply\.id\}`/,
      "键又挂回回复上了 —— 换一个采纳对象就能再付一次全额",
    );
  });

  it("**结算过之后不许再追加悬赏** —— 不然扣了款却发不出去", () => {
    const addBounty = qa.slice(qa.indexOf("export async function addBounty"));
    assert.match(
      addBounty.slice(0, addBounty.indexOf("export async function acceptAnswer")),
      /bountyAwarded\(post\.id\)/,
      "addBounty 没有挡住「已经结算过的悬赏」",
    );
  });

  it("**发放失败时采纳不落库** —— 静默吞掉的话，帖子标着已解决而答主一分没拿到", () => {
    const accept = qa.slice(qa.indexOf("export async function acceptAnswer"));
    const awardAt = accept.indexOf("grantPoints({");
    const solveAt = accept.indexOf("solvedReplyId: reply.id");
    assert.ok(awardAt >= 0 && solveAt >= 0, "acceptAnswer 的结构变了，这条断言要重写");
    assert.ok(awardAt < solveAt, "发钱必须排在落采纳之前 —— 反过来那一半失败是不可自愈的");
    assert.match(accept.slice(awardAt), /if \(!award\.ok\) return fail\(/, "没有检查发放结果");
  });
});
