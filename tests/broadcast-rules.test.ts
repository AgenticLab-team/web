import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_SENDS_PER_DAY,
  MAX_WECHAT_LENGTH,
  MIN_SEND_GAP_MS,
  REVOKE_WINDOW_MS,
  channelLabel,
  checkApprove,
  checkDraft,
  checkRevoke,
  checkSend,
  contentHash,
  sendIntervalMs,
  statusLabel,
} from "@/lib/broadcast/rules";

/**
 * 群发。
 *
 * 这是全站唯一**做错之后没法挽回**的功能。
 * 删错帖可以恢复，扣错分可以冲正，封错人可以解封 ——
 * 但一条发到一千六百人手机上响过的消息，撤回窗口只有几分钟且不保证成功。
 *
 * 所以这里的每条断言都不是为了「更规范」，
 * 是为了让出错的那一次尽可能不发生。
 */

const MINUTE = 60_000;
const NOW = 1_800_000_000_000;

describe("内容冻结", () => {
  it("同样的内容算出同样的哈希", () => {
    assert.equal(contentHash("公告内容"), contentHash("公告内容"));
  });

  it("改一个字哈希就变", () => {
    assert.notEqual(contentHash("公告内容"), contentHash("公告内容。"));
  });

  it("首尾空白不影响 —— 那不是实质改动", () => {
    assert.equal(contentHash("  公告内容  "), contentHash("公告内容"));
  });

  it("中间的空白算改动", () => {
    assert.notEqual(contentHash("公告 内容"), contentHash("公告内容"));
  });
});

describe("起草", () => {
  const base = {
    channel: "wechat" as const,
    content: "本周论坛精选：三篇关于向量检索的讨论",
    targetConvIds: ["g1"],
    availableConvIds: ["g1", "g2"],
  };

  it("正常草稿通过", () => {
    assert.equal(checkDraft(base).ok, true);
  });

  it("太短的不行", () => {
    assert.equal(checkDraft({ ...base, content: "看看" }).ok, false);
  });

  it("**微信群发有长度上限** —— 太长在手机上会被折叠，等于没人看", () => {
    const r = checkDraft({ ...base, content: "长".repeat(MAX_WECHAT_LENGTH + 1) });
    assert.equal(r.ok, false);
    assert.match(r.error!, /折叠/);
  });

  it("站内公告不受微信长度限制", () => {
    assert.equal(
      checkDraft({ ...base, channel: "site", content: "长".repeat(MAX_WECHAT_LENGTH + 100) }).ok,
      true,
    );
  });

  it("**目标必须在可发送列表里**", () => {
    // 发到一个上游没绑定的群只会失败，而失败要等发出去才知道
    const r = checkDraft({ ...base, targetConvIds: ["g1", "不存在的群"] });
    assert.equal(r.ok, false);
  });

  it("没有任何可发送的群时拒绝", () => {
    assert.equal(checkDraft({ ...base, targetConvIds: [], availableConvIds: [] }).ok, false);
  });
});

describe("双人复核", () => {
  const hash = contentHash("公告内容");
  const base = {
    actorId: "u_reviewer",
    createdBy: "u_author",
    status: "pending",
    frozenHash: hash,
    currentHash: hash,
    note: "内容没问题，同意发",
  };

  it("另一个人复核通过", () => {
    assert.equal(checkApprove(base).ok, true);
  });

  it("**不能复核自己起草的**", () => {
    // 起草人自己批准的话，这套流程只是给一个人多点了一次鼠标
    const r = checkApprove({ ...base, actorId: "u_author" });
    assert.equal(r.ok, false);
    assert.match(r.error!, /换一个人/);
  });

  it("必须写复核意见", () => {
    assert.equal(checkApprove({ ...base, note: " " }).ok, false);
  });

  it("**提交复核后改了内容就得重新提交**", () => {
    // 「先提一版温和的骗到批准，再改成别的」这条路必须堵死
    const r = checkApprove({ ...base, currentHash: contentHash("改过的内容") });
    assert.equal(r.ok, false);
    assert.match(r.error!, /被改过/);
  });

  it("没有冻结哈希的不能复核", () => {
    assert.equal(checkApprove({ ...base, frozenHash: null }).ok, false);
  });

  it("不在待复核状态的不能复核", () => {
    assert.equal(checkApprove({ ...base, status: "draft" }).ok, false);
    assert.equal(checkApprove({ ...base, status: "sent" }).ok, false);
  });
});

describe("发送前的闸门", () => {
  const hash = contentHash("公告内容");
  const base = {
    status: "approved",
    frozenHash: hash,
    currentHash: hash,
    approvedBy: "u_reviewer",
    msSinceLastSend: null as number | null,
    sentToday: 0,
    quota: { perMinute: { used: 0, limit: 20 }, perHour: { used: 0, limit: 200 } },
    targetCount: 12,
  };

  it("条件齐全时放行", () => {
    assert.equal(checkSend(base).ok, true);
  });

  it("没通过复核不能发", () => {
    assert.equal(checkSend({ ...base, status: "pending" }).ok, false);
  });

  it("**复核之后又被改过，最后一道闸也要拦住**", () => {
    const r = checkSend({ ...base, currentHash: contentHash("偷偷改了") });
    assert.equal(r.ok, false);
    assert.match(r.error!, /不一致/);
  });

  it("**每天的次数有上限** —— 再多大家会开始屏蔽这个群", () => {
    const r = checkSend({ ...base, sentToday: MAX_SENDS_PER_DAY });
    assert.equal(r.ok, false);
    assert.match(r.error!, /屏蔽/);
  });

  it("**两次之间要间隔** —— 机器人已经因为高频操作被风控过一次", () => {
    const r = checkSend({ ...base, msSinceLastSend: 5 * MINUTE });
    assert.equal(r.ok, false);
    assert.match(r.error!, /还要等/);
  });

  it("间隔够了就放行", () => {
    assert.equal(checkSend({ ...base, msSinceLastSend: MIN_SEND_GAP_MS + 1000 }).ok, true);
  });

  it("**上游额度不够时提前拒绝，而不是发到一半被拒**", () => {
    // 发到一半是最糟的状态：一部分人收到了，一部分没有，
    // 而重发会让前一部分人收到两遍
    const r = checkSend({
      ...base,
      targetCount: 12,
      quota: { perMinute: { used: 0, limit: 20 }, perHour: { used: 195, limit: 200 } },
    });
    assert.equal(r.ok, false);
    assert.match(r.error!, /发不完/);
  });

  it("本分钟额度用完时也拒绝", () => {
    const r = checkSend({
      ...base,
      quota: { perMinute: { used: 20, limit: 20 }, perHour: { used: 0, limit: 200 } },
    });
    assert.equal(r.ok, false);
  });
});

describe("逐群间隔", () => {
  it("**不会一秒钟连发十二条** —— 那是最典型的风控触发姿势", () => {
    const gap = sendIntervalMs(20);
    assert.ok(gap >= 6000, `间隔 ${gap}ms 太短了`);
  });

  it("额度越小间隔越长", () => {
    assert.ok(sendIntervalMs(5) > sendIntervalMs(20));
  });

  it("额度为 0 或负数时给一个安全的大间隔，而不是除以 0", () => {
    assert.ok(Number.isFinite(sendIntervalMs(0)));
    assert.ok(sendIntervalMs(0) >= 60_000);
    assert.ok(Number.isFinite(sendIntervalMs(-5)));
  });
});

describe("撤回", () => {
  const base = {
    status: "sent",
    msgSvrId: "123456",
    sentAt: NOW - MINUTE,
    now: NOW,
  };

  it("窗口内可以撤回", () => {
    assert.equal(checkRevoke(base).ok, true);
  });

  it("**超出窗口就明说撤不回来，别让人白试**", () => {
    const r = checkRevoke({ ...base, sentAt: NOW - 10 * MINUTE });
    assert.equal(r.ok, false);
    assert.match(r.error!, /撤不回来/);
  });

  it("**没留下 msg_svr_id 就撤不回来** —— 它是唯一凭据", () => {
    const r = checkRevoke({ ...base, msgSvrId: null });
    assert.equal(r.ok, false);
    assert.match(r.error!, /撤不回来/);
  });

  it("没发出去的不用撤", () => {
    assert.equal(checkRevoke({ ...base, status: "failed" }).ok, false);
  });

  it("撤回窗口是两分钟", () => {
    assert.equal(REVOKE_WINDOW_MS, 2 * MINUTE);
  });
});

describe("展示文案", () => {
  it("每个状态都有中文名", () => {
    for (const s of ["draft", "pending", "approved", "sending", "sent", "failed", "rejected", "canceled"]) {
      assert.notEqual(statusLabel(s), s, `${s} 没有中文名`);
    }
  });

  it("两个渠道都有中文名", () => {
    assert.equal(channelLabel("wechat"), "微信群发");
    assert.equal(channelLabel("site"), "站内公告");
  });

  it("未知值原样返回", () => {
    assert.equal(statusLabel("weird"), "weird");
    assert.equal(channelLabel("sms"), "sms");
  });
});
