import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { classifyCollection, MIN_GROUPS, STALE_RATIO } from "@/lib/sync/collection-health";
import type { Freshness } from "@/lib/sync/health";

/**
 * 采集健康 —— 「数据还在不在进来」。
 *
 * ─────────────────────────────────────────
 * 15 天的归档缺口，当时没有任何东西报过
 * ─────────────────────────────────────────
 *
 * 线上 2026-07-15 ~ 07-29，12 个群一条消息都没有，
 * 上游对账证实那段上游自己也没有 —— 机器人当时没在采集。
 * 那半个月的聊天记录**永久没了**。
 *
 * 而它发生的时候一声不响，原因是结构性的：
 *
 *   · 逐群的新鲜度判定早就有了，但只渲染在群页上，
 *     **从没进过 system_health**，够不到告警
 *   · 健康探测里的 upstream_api / frp_tunnel 问的是「接口通不通」，
 *     而那两周接口大概率一直是通的 —— 只是没有内容。
 *     返回 200、探测一路绿灯
 *
 * ─────────────────────────────────────────
 * 这一档测试最要紧的是**不许误报**
 * ─────────────────────────────────────────
 *
 * 它 down 的时候 `/api/health` 会返回 503，外部监控会把人叫起来。
 * 而凌晨所有人都在睡觉的时候，一半的群本来就会越过容忍线。
 *
 * 门槛是拿线上 30 天真实消息按小时回放定出来的：
 *   · 非缺口期 384 个采样点，最高同时陈旧 55.6%（08-02 早上 6:52），
 *     按现在这条规则**一次都没有误报**
 *   · 真实缺口期 57 个采样点，**100% 报出**（9/9 陈旧，最活跃的群也停了）
 */

const g = (level: Freshness, dailyAverage: number) => ({ level, dailyAverage });

/** 一个典型的站：一个很活跃的群 + 若干冷清的群 */
const site = (levels: Freshness[]) =>
  levels.map((l, i) => g(l, i === 0 ? 700 : 20));

describe("采集判定", () => {
  it("都在进数据 = ok", () => {
    const v = classifyCollection({ groups: site(["fresh", "fresh", "fresh", "fresh"]) });
    assert.equal(v.status, "ok");
    assert.equal(v.stale, 0);
    assert.equal(v.total, 4);
  });

  it("**全停 = down**", () => {
    const v = classifyCollection({ groups: site(["stale", "stale", "stale", "stale"]) });
    assert.equal(v.status, "down");
    assert.equal(v.stale, 4);
  });

  it("**凌晨那种自然安静不能报 down** —— 冷清的群先停，最活跃的还在说", () => {
    /*
     * 线上回放里最坏的一刻就长这样：08-02 早上 6:52，
     * 55.6% 的群同时越线，而日均 701 条的那个群照样在说话
     * （它历史最大静默 6.9 小时，够不到 12 小时的容忍线）。
     *
     * 只看比例的话这里离触发只差一点点；加上「最活跃的也得停」
     * 这条硬条件之后，自然安静再也够不到线。
     */
    const v = classifyCollection({
      groups: [g("fresh", 700), g("stale", 20), g("stale", 15), g("stale", 13)],
    });
    assert.equal(v.status, "degraded", "把凌晨的自然安静报成采集中断了");
    assert.match(v.detail, /最活跃的群还在正常说话/);
  });

  it("**最活跃的群停了、但只有它停 —— 也不是 down**", () => {
    // 一个群被踢出去、或那个群自己出事，不等于采集断了
    const v = classifyCollection({
      groups: [g("stale", 700), g("fresh", 20), g("fresh", 15), g("fresh", 13)],
    });
    assert.equal(v.status, "degraded");
    assert.match(v.detail, /含最活跃的那个/);
  });

  it("**两个条件都满足才 down**", () => {
    const levels: Freshness[] = ["stale", "stale", "stale", "fresh"];
    // 比例 3/4 = 0.75 达标，且最活跃的那个是 stale
    assert.equal(classifyCollection({ groups: site(levels) }).status, "down");
    // 同样的比例，但最活跃的那个是 fresh → 不 down
    assert.equal(
      classifyCollection({
        groups: [g("fresh", 700), g("stale", 20), g("stale", 15), g("stale", 13)],
      }).status,
      "degraded",
    );
  });

  it("**刚接入的群不参加判定** —— 否则接入当天就报警", () => {
    /*
     * unknown 的含义是「刚接入，还在观察」或「从没同步到过消息」，
     * 两者都不是采集断了的证据。
     */
    const v = classifyCollection({
      groups: [g("stale", 700), g("stale", 20), g("unknown", 0), g("unknown", 0)],
    });
    assert.equal(v.total, 2, "unknown 被算进分母了");
    assert.equal(v.status, "down");
  });

  it("**样本太少不下结论，而且说清楚是「没法判断」**", () => {
    /*
     * 只接了一个群的时候，「100% 的群陈旧」和「那个群没人说话」
     * 是同一件事，分不开就不要报。
     */
    const v = classifyCollection({ groups: [g("stale", 700)] });
    assert.equal(v.status, "ok");
    assert.match(v.detail, /样本太少/);
    assert.equal(v.detail.includes("都在正常进数据"), false, "把「没法判断」说成了「一切正常」");
  });

  it("一个群都没有时不崩", () => {
    const v = classifyCollection({ groups: [] });
    assert.equal(v.status, "ok");
    assert.equal(v.total, 0);
  });

  it("**全是 unknown 时也走样本不足那一档**", () => {
    const v = classifyCollection({ groups: [g("unknown", 0), g("unknown", 0)] });
    assert.equal(v.total, 0);
    assert.match(v.detail, /样本太少/);
  });

  it("quiet 不算陈旧 —— 那一档的含义就是「本来就冷清」", () => {
    const v = classifyCollection({
      groups: [g("stale", 700), g("quiet", 0.5), g("quiet", 0.3), g("quiet", 0.2)],
    });
    assert.equal(v.stale, 1);
    assert.equal(v.status, "degraded");
  });

  it("**每一档都说得出下一步**", () => {
    for (const groups of [
      site(["stale", "stale", "stale", "stale"]),
      site(["fresh", "stale", "fresh", "fresh"]),
      site(["fresh", "fresh"]),
    ]) {
      const v = classifyCollection({ groups });
      assert.ok(v.detail.length > 10, `${v.status} 的说明太短`);
    }
  });

  it("门槛是常量，改动看得见", () => {
    assert.equal(STALE_RATIO, 0.75);
    assert.equal(MIN_GROUPS, 2);
  });
});

describe("接线", () => {
  const health = readFileSync(new URL("../src/lib/health.ts", import.meta.url), "utf8");
  const rules = readFileSync(new URL("../src/lib/alerts/rules.ts", import.meta.url), "utf8");
  const schema = readFileSync(
    new URL("../src/lib/db/schema/system.ts", import.meta.url),
    "utf8",
  );

  it("**进了健康探测** —— 不进 system_health 就够不到告警", () => {
    /*
     * 这正是当初漏掉那 15 天的原因：逐群新鲜度早就算得出来，
     * 但它只渲染在群页上，从来没有写进 system_health。
     */
    assert.match(health, /export function probeCollection/);
    assert.match(health, /probeCollection\(\),/);
  });

  it("**component 枚举里有它**", () => {
    assert.match(schema, /"collection"/);
    assert.match(health, /\| "collection"/);
  });

  it("**算「挂了多久」时认得它** —— 否则永远够不到报警线", () => {
    assert.match(health, /"offsite" \| "collection"/);
  });

  it("**有自己的告警节奏**", () => {
    assert.match(rules, /collection: \{[\s\S]{0,120}fireAfterMs/);
  });

  it("**不指望靠微信发出去** —— 报信的人和出事的人是同一个", () => {
    /*
     * collection down 的含义就是「机器人没在收数据」，
     * 而发告警要靠的正是那个机器人。和 upstream 是同一类问题。
     * 真正的兜底是 /api/health 返回 503。
     */
    assert.match(rules, /alertComponent !== "collection"/);
  });

  it("**有中文名和排查提示** —— 一条只写着 collection 的告警等于没写", () => {
    assert.match(rules, /collection: "采集/);
    assert.match(rules, /collection: "接口通不通看 upstream/);
  });
});
