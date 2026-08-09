import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ALERT_COMPONENT_ALIASES,
  DEFAULT_RULES,
  alertComponentFor,
  canDeliverViaWechat,
  componentLabel,
  decideAlert,
  formatAlert,
  formatDuration,
  probeComponentsFor,
  ruleFor,
  worstStatus,
  type AlertState,
} from "@/lib/alerts/rules";

const NOW = 1_700_000_000_000;
const quiet: AlertState = { firing: false, notifiedAt: null };

function decide(over: Partial<Parameters<typeof decideAlert>[0]>) {
  return decideAlert({
    component: "db",
    status: "down",
    downForMs: null,
    state: quiet,
    now: NOW,
    ...over,
  });
}

describe("告警抑制 —— 抖动不该报警", () => {
  it("单次探测失败不报", () => {
    const v = decide({ downForMs: 30_000 });
    assert.equal(v.action, "none");
    assert.match(v.reason, /还没到/);
  });

  it("刚好到线才报", () => {
    const rule = DEFAULT_RULES.db;
    assert.equal(decide({ downForMs: rule.fireAfterMs - 1 }).action, "none");
    assert.equal(decide({ downForMs: rule.fireAfterMs }).action, "fire");
  });

  it("每个组件的报警线不同 —— 磁盘是慢性问题，报太急会让人麻木", () => {
    // 磁盘满 10 分钟不报，上游断 10 分钟要报
    assert.equal(decide({ component: "disk", downForMs: 10 * 60_000 }).action, "none");
    assert.equal(decide({ component: "upstream", downForMs: 10 * 60_000 }).action, "fire");
    assert.ok(DEFAULT_RULES.disk.fireAfterMs > DEFAULT_RULES.upstream.fireAfterMs);
  });

  it("没登记的组件有兜底规则，不会因为查不到就永远不报", () => {
    const rule = ruleFor("something_new");
    assert.ok(rule.fireAfterMs > 0);
    assert.ok(rule.renotifyAfterMs > rule.fireAfterMs);
    assert.equal(decide({ component: "something_new", downForMs: rule.fireAfterMs }).action, "fire");
  });

  it("已经报过的同一次故障不重复打扰", () => {
    const v = decide({
      downForMs: 3600_000,
      state: { firing: true, notifiedAt: NOW - 60_000 },
    });
    assert.equal(v.action, "none");
  });

  it("拖太久没人处理才重提醒", () => {
    const gap = DEFAULT_RULES.db.renotifyAfterMs;
    assert.equal(
      decide({ downForMs: gap, state: { firing: true, notifiedAt: NOW - gap + 1 } }).action,
      "none",
    );
    assert.equal(
      decide({ downForMs: gap, state: { firing: true, notifiedAt: NOW - gap } }).action,
      "renotify",
    );
  });

});

describe("投递失败要重试 —— 沉默和「一切正常」长得一模一样", () => {
  it("从来没送到过就按重试节奏再试，而不是永远沉默", () => {
    const v = decide({
      downForMs: 10 * 3600_000,
      state: { firing: true, notifiedAt: null, attemptedAt: null },
    });
    assert.equal(v.action, "renotify");
    assert.match(v.reason, /重试/);
  });

  it("刚试过就等下一轮，不在同一分钟里连打", () => {
    const v = decide({
      downForMs: 10 * 3600_000,
      state: { firing: true, notifiedAt: null, attemptedAt: NOW - 1000 },
    });
    assert.equal(v.action, "none");
  });

  it("重试节奏比重提醒快得多 —— 那是两件事", () => {
    for (const [key, rule] of Object.entries(DEFAULT_RULES)) {
      assert.ok(
        rule.retryAfterMs < rule.renotifyAfterMs,
        `${key} 的重试间隔不该跟重提醒一样长：没送到 ≠ 没人处理`,
      );
    }
  });

  it("到了重试线就再试", () => {
    const gap = DEFAULT_RULES.db.retryAfterMs;
    assert.equal(
      decide({
        downForMs: 10 * 3600_000,
        state: { firing: true, notifiedAt: null, attemptedAt: NOW - gap },
      }).action,
      "renotify",
    );
  });

  it("送达过之后就回到重提醒的节奏，不再频繁重试", () => {
    const v = decide({
      downForMs: 10 * 3600_000,
      state: { firing: true, notifiedAt: NOW - 10 * 60_000, attemptedAt: NOW - 10 * 60_000 },
    });
    assert.equal(v.action, "none", "已经送到过就该安静，等重提醒的时间到");
  });
});

describe("恢复", () => {
  it("恢复了要发已恢复 —— 没有收尾的告警会让人一直手动去查", () => {
    const v = decide({ status: "ok", downForMs: null, state: { firing: true, notifiedAt: NOW } });
    assert.equal(v.action, "resolve");
    assert.equal(v.severity, "info");
  });

  it("本来就没报警，恢复不产生噪音", () => {
    assert.equal(decide({ status: "ok", downForMs: null }).action, "none");
  });
});

describe("严重程度", () => {
  it("断了是严重，降级是警告", () => {
    assert.equal(decide({ downForMs: 3600_000 }).severity, "critical");
    assert.equal(decide({ status: "degraded", downForMs: 3600_000 }).severity, "warning");
  });

  it("持续降级同样会报警 —— 半死不活也要有人看", () => {
    assert.equal(decide({ status: "degraded", downForMs: 3600_000 }).action, "fire");
  });
});

describe("上游与隧道是同一件事", () => {
  it("两个探测组件合成一个告警组件", () => {
    assert.equal(alertComponentFor("upstream_api"), "upstream");
    assert.equal(alertComponentFor("frp_tunnel"), "upstream");
    assert.equal(alertComponentFor("db"), "db");
  });

  it("反向能查回所有探测组件 —— 算挂了多久要一起看", () => {
    const probes = probeComponentsFor("upstream");
    assert.deepEqual([...probes].sort(), ["frp_tunnel", "upstream_api"]);
    assert.deepEqual(probeComponentsFor("db"), ["db"]);
  });

  it("别名表里的每个目标都有自己的告警规则", () => {
    for (const target of new Set(Object.values(ALERT_COMPONENT_ALIASES))) {
      assert.ok(DEFAULT_RULES[target], `${target} 没有登记规则，会掉到兜底值上`);
    }
  });

  it("合并时取最坏的状态 —— 一个探测正常掩盖不了另一个断了", () => {
    assert.equal(worstStatus(["ok", "down"]), "down");
    assert.equal(worstStatus(["ok", "degraded"]), "degraded");
    assert.equal(worstStatus(["ok", "ok"]), "ok");
    assert.equal(worstStatus([]), "ok");
  });
});

describe("诚实的局限 —— 上游挂了告警发不出去", () => {
  it("上游相关的告警不走微信（报信的人和出事的人是同一个）", () => {
    assert.equal(canDeliverViaWechat("upstream"), false);
    assert.equal(canDeliverViaWechat("upstream_api"), false);
    assert.equal(canDeliverViaWechat("frp_tunnel"), false);
  });

  it("其余组件可以走微信", () => {
    assert.equal(canDeliverViaWechat("db"), true);
    assert.equal(canDeliverViaWechat("disk"), true);
  });

  it("别名的两端结论一致 —— 不会出现一个能发一个不能发", () => {
    for (const [probe, target] of Object.entries(ALERT_COMPONENT_ALIASES)) {
      assert.equal(
        canDeliverViaWechat(probe),
        canDeliverViaWechat(target),
        `${probe} 与 ${target} 的可投递结论不一致`,
      );
    }
  });
});

describe("告警文案", () => {
  it("带上先查什么 —— 半夜被叫醒的人不该还要自己回忆", () => {
    const m = formatAlert({
      component: "upstream",
      status: "down",
      detail: "connect ECONNREFUSED",
      downForMs: 25 * 60_000,
    });
    assert.match(m.title, /中断/);
    assert.match(m.body, /25 分钟/);
    assert.match(m.body, /ECONNREFUSED/);
    assert.match(m.body, /frp/, "没有告诉人先查什么");
  });

  it("每个有规则的组件都有可读的名字，不会把组件 key 直接发给人", () => {
    for (const key of Object.keys(DEFAULT_RULES)) {
      assert.notEqual(componentLabel(key), key, `${key} 没有中文名`);
    }
  });

  it("恢复文案不带故障排查提示", () => {
    const m = formatAlert({
      component: "db",
      status: "ok",
      detail: "完整性检查通过",
      downForMs: 3600_000,
      resolved: true,
    });
    assert.match(m.title, /已恢复/);
    assert.doesNotMatch(m.body, /WAL/);
  });

  it("detail 缺失也能成句", () => {
    const m = formatAlert({ component: "disk", status: "degraded", detail: null, downForMs: null });
    assert.ok(m.title.length > 0);
    assert.ok(!m.body.startsWith(" ·"));
  });

  it("时长按量级说人话", () => {
    assert.equal(formatDuration(30_000), "不到一分钟");
    assert.equal(formatDuration(25 * 60_000), "25 分钟");
    assert.equal(formatDuration(3 * 3600_000), "3 小时");
    assert.equal(formatDuration(2 * 86_400_000), "2 天");
  });
});
