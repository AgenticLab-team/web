import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  DEFAULT_STEP_TIMEOUT_MS,
  SLOW_TICK_MS,
  runSteps,
  summarize,
  tickFailureReport,
  tickHealth,
} from "@/lib/ops/tick";

const source = readFileSync(new URL("../scripts/health.ts", import.meta.url), "utf8");

/**
 * 定时一轮的步骤编排。
 *
 * ─────────────────────────────────────────
 * 这个文件存在的理由只有一句
 * ─────────────────────────────────────────
 *
 * 健康探测那一轮要做七件事，原来是七个 await 排成一串 ——
 * 任何一步抛异常，后面的全都不跑。而**告警投递排在最后**。
 *
 * 也就是说：只要前面任何一步出问题，「告诉你出问题了」的那一步
 * 就不会执行。报信的人被它要报的那件事挡在了门外。
 */

describe("**一步失败不能掐断后面的步骤**", () => {
  it("中间失败，后面照跑", async () => {
    const ran: string[] = [];
    const report = await runSteps([
      { name: "a", run: () => ran.push("a") },
      {
        name: "b",
        run: () => {
          throw new Error("炸了");
        },
      },
      { name: "c", run: () => ran.push("c") },
    ] as never);

    assert.deepEqual(ran, ["a", "c"], "b 失败之后 c 没跑");
    assert.equal(report.failed.length, 1);
    assert.equal(report.failed[0].name, "b");
  });

  it("**第一步就失败，告警投递照样跑** —— 这是全部的重点", async () => {
    let alerted = false;
    const report = await runSteps([
      {
        name: "存储快照",
        run: () => {
          throw new Error("磁盘读不到");
        },
      },
      { name: "告警投递", run: () => (alerted = true) },
    ] as never);

    assert.equal(alerted, true, "前面一步失败就把告警投递掐掉了");
    assert.equal(report.steps.find((s) => s.name === "告警投递")?.ok, true);
  });

  it("异步步骤失败也一样隔开", async () => {
    const ran: string[] = [];
    await runSteps([
      { name: "a", run: async () => Promise.reject(new Error("async 炸了")) },
      { name: "b", run: () => ran.push("b") },
    ] as never);
    assert.deepEqual(ran, ["b"]);
  });

  it("全部成功时 failed 是空的", async () => {
    const report = await runSteps([
      { name: "a", run: () => 1 },
      { name: "b", run: async () => 2 },
    ] as never);
    assert.deepEqual(report.failed, []);
    assert.ok(report.steps.every((s) => s.ok));
  });

  it("失败的原因要留下来 —— 只知道「失败了」查不出任何东西", async () => {
    const report = await runSteps([
      {
        name: "a",
        run: () => {
          throw new Error("上游 502");
        },
      },
    ] as never);
    assert.match(report.failed[0].error ?? "", /502/);
  });

  it("抛非 Error 的东西也接得住", async () => {
    const report = await runSteps([
      {
        name: "a",
        run: () => {
          throw "字符串";
        },
      },
    ] as never);
    assert.equal(report.failed[0].error, "字符串");
  });
});

describe("超时 —— 卡住的一步会让所有定时任务停摆", () => {
  it("**卡住的步骤会被打断**", async () => {
    /*
     * systemd 不会为一个还在运行的 oneshot 单元起第二个实例。
     * 也就是说一步卡死 = 从那一刻起所有定时任务都停了，
     * 而且没有任何报错 —— 只是再也没有新的日志。
     */
    const report = await runSteps([
      { name: "卡住的", run: () => new Promise(() => {}), timeoutMs: 50 },
      { name: "后面的", run: () => "跑到了", describe: (v: string) => v },
    ] as never);

    assert.equal(report.failed.length, 1);
    assert.match(report.failed[0].error ?? "", /还没返回/);
    assert.equal(report.steps[1].note, "跑到了", "卡住的那步把后面也拖住了");
  });

  it("默认超时是有限的，不是无穷", () => {
    assert.ok(DEFAULT_STEP_TIMEOUT_MS > 0);
    assert.ok(DEFAULT_STEP_TIMEOUT_MS <= 120_000, "默认超时比定时器间隔还长就没有意义");
  });

  it("同步步骤不受超时影响 —— 它本来就没法被打断", async () => {
    const report = await runSteps([
      { name: "同步", run: () => "立刻好了", timeoutMs: 1 },
    ] as never);
    assert.equal(report.steps[0].ok, true);
  });
});

describe("耗时", () => {
  it("量得出整轮时间", async () => {
    let clock = 0;
    const report = await runSteps(
      [
        { name: "a", run: () => (clock += 100) },
        { name: "b", run: () => (clock += 200) },
      ] as never,
      () => clock,
    );
    assert.equal(report.totalMs, 300);
    assert.equal(report.steps[0].ms, 100);
    assert.equal(report.steps[1].ms, 200);
  });

  it("**跑太久要说一声** —— 堆叠的第一个症状是「好像变慢了」，没人会想到是这里", async () => {
    let clock = 0;
    const slow = await runSteps(
      [{ name: "慢", run: () => (clock += SLOW_TICK_MS + 1) }] as never,
      () => clock,
    );
    assert.equal(slow.slow, true);
    assert.match(summarize(slow), /超过定时器间隔的一半/);
  });

  it("正常耗时不报慢", async () => {
    const report = await runSteps([{ name: "快", run: () => 1 }] as never);
    assert.equal(report.slow, false);
    assert.doesNotMatch(summarize(report), /超过/);
  });

  it("警戒线小于定时器间隔（5 分钟）", () => {
    assert.ok(SLOW_TICK_MS < 300_000, "警戒线比定时器间隔还大，等于永远不会触发");
  });
});

describe("汇总", () => {
  it("**没有失败时不产生告警** —— 为「一切正常」发告警是让人静音通道最快的办法", async () => {
    const report = await runSteps([{ name: "a", run: () => 1 }] as never);
    assert.equal(tickFailureReport(report), null);
  });

  it("有失败时汇成一条，带上每一步的原因", async () => {
    const report = await runSteps([
      {
        name: "赛季结算",
        run: () => {
          throw new Error("表锁了");
        },
      },
      {
        name: "称号结算",
        run: () => {
          throw new Error("没有称号表");
        },
      },
    ] as never);

    const failure = tickFailureReport(report)!;
    assert.match(failure.title, /2 步失败/);
    assert.match(failure.body, /赛季结算：表锁了/);
    assert.match(failure.body, /称号结算：没有称号表/);
  });

  it("一行总结里失败的步骤有标记", async () => {
    const report = await runSteps([
      { name: "好的", run: () => 1 },
      {
        name: "坏的",
        run: () => {
          throw new Error("x");
        },
      },
    ] as never);
    assert.match(summarize(report), /坏的✗/);
    assert.doesNotMatch(summarize(report), /好的✗/);
  });
});

describe("真正的那一轮", () => {

  it("**health 脚本必须走 runSteps** —— 不然这个文件测的是一段没人用的代码", () => {
    assert.match(source, /runSteps\(/);
  });

  it("那一轮里该跑的六件事一件不少", () => {
    for (const name of ["存储快照", "自动裁剪", "置顶到期", "赛季结算", "称号结算", "告警投递"]) {
      assert.ok(source.includes(`name: "${name}"`), `${name} 不在这一轮里`);
    }
  });

  it("**探活失败时不能让这一轮停下** —— 那正是最需要发告警的时刻", () => {
    /*
     * runHealthChecks 必须被 try 包住，而不是裸 await。
     * 取的是**调用点**那一处（不是文件顶部的 import），
     * 所以从函数体开始找 —— 第一版从文件开头找，撞上了 import 那一行。
     */
    const body = source.slice(source.indexOf("async function main"));
    const callAt = body.indexOf("await runHealthChecks");
    assert.ok(callAt > 0, "找不到探活的调用点");

    const before = body.slice(0, callAt);
    const after = body.slice(callAt, body.indexOf("runSteps("));
    assert.match(before.slice(-200), /try \{/, "探活没有被 try 包住");
    assert.match(after, /catch/, "探活抛异常之后没有兜住");
  });

  it("有失败时退非零，让 systemd 标成失败", () => {
    assert.match(source, /process\.exit\(1\)/);
    assert.match(source, /tickFailureReport/);
  });
});

describe("**把失败接进告警链路** —— 退出码和日志没有人看", () => {
  it("全过时是 ok，带上耗时", async () => {
    const report = await runSteps([{ name: "a", run: () => 1 }] as never);
    const health = tickHealth(report, null);
    assert.equal(health.status, "ok");
    assert.match(health.detail, /1 步全过/);
  });

  it("有步骤失败就是 down，详情写清楚是哪一步", async () => {
    const report = await runSteps([
      {
        name: "赛季结算",
        run: () => {
          throw new Error("表锁了");
        },
      },
    ] as never);
    const health = tickHealth(report, null);
    assert.equal(health.status, "down");
    assert.match(health.detail, /赛季结算：表锁了/);
  });

  it("探活整体失败优先报出来 —— 那时候别的步骤的结论都不可信", async () => {
    const report = await runSteps([{ name: "a", run: () => 1 }] as never);
    const health = tickHealth(report, "连不上数据库");
    assert.equal(health.status, "down");
    assert.match(health.detail, /探活整体失败/);
  });

  it("**只是慢是 degraded，不是 down** —— 还没坏，但再慢就会堆叠", async () => {
    let clock = 0;
    const report = await runSteps(
      [{ name: "慢", run: () => (clock += SLOW_TICK_MS + 1) }] as never,
      () => clock,
    );
    const health = tickHealth(report, null);
    assert.equal(health.status, "degraded");
    assert.match(health.detail, /堆叠|超过定时器间隔/);
  });

  it("详情不会长到写不进库", async () => {
    const report = await runSteps(
      Array.from({ length: 20 }, (_, i) => ({
        name: `步骤${i}`,
        run: () => {
          throw new Error("很长的错误信息".repeat(20));
        },
      })) as never,
    );
    assert.ok(tickHealth(report, null).detail.length <= 200);
  });

  it("**cron 有自己的告警规则，而且比上游宽松** —— 偶发一次不该报", async () => {
    const rules = await import("@/lib/alerts/rules");
    const cron = rules.DEFAULT_RULES.cron;
    assert.ok(cron, "cron 没有登记告警规则 —— 那这条链路是断的");
    assert.ok(cron.fireAfterMs > rules.DEFAULT_RULES.db.fireAfterMs);
    assert.notEqual(rules.componentLabel("cron"), "cron", "没有中文名");
    assert.equal(rules.canDeliverViaWechat("cron"), true);
  });

  it("health 脚本真的写了这条状态 —— 不写的话上面全是空谈", () => {
    assert.match(source, /recordTickHealth\(/);
    assert.match(source, /lastTickHealth\(/);
  });
});

describe("**「还没配好」和「真的坏了」不该是同一个信号**", () => {
  it("标了 critical:false 的失败不让这一轮退非零", async () => {
    const report = await runSteps([
      { name: "本机备份", run: () => "好了" },
      {
        name: "推异地",
        critical: false,
        run: () => {
          throw new Error("没有配置对象存储");
        },
      },
    ] as never);

    assert.equal(report.failed.length, 1, "失败照样要记下来");
    assert.equal(report.criticalFailed.length, 0);
    assert.equal(tickFailureReport(report), null, "异地没配好把备份这一轮标红了");
  });

  it("**它仍然出现在日志里** —— 不算致命不等于不用说", async () => {
    const report = await runSteps([
      {
        name: "推异地",
        critical: false,
        run: () => {
          throw new Error("没配置");
        },
      },
    ] as never);
    assert.match(summarize(report), /推异地✗/);
  });

  it("非致命失败的健康状态是 degraded，不是 down", async () => {
    const report = await runSteps([
      {
        name: "推异地",
        critical: false,
        run: () => {
          throw new Error("没配置");
        },
      },
    ] as never);
    assert.equal(tickHealth(report, null).status, "degraded");
  });

  it("致命与非致命同时失败时，按致命算", async () => {
    const report = await runSteps([
      {
        name: "本机备份",
        run: () => {
          throw new Error("磁盘满了");
        },
      },
      {
        name: "推异地",
        critical: false,
        run: () => {
          throw new Error("没配置");
        },
      },
    ] as never);

    assert.equal(tickHealth(report, null).status, "down");
    const failure = tickFailureReport(report)!;
    assert.match(failure.body, /本机备份/);
    assert.doesNotMatch(failure.body, /推异地/, "非致命的混进了告警正文");
  });

  it("默认是致命的 —— 不写 critical 的步骤失败要算数", async () => {
    const report = await runSteps([
      {
        name: "a",
        run: () => {
          throw new Error("x");
        },
      },
    ] as never);
    assert.equal(report.criticalFailed.length, 1);
  });
});

describe("另外两个定时任务也隔开了", () => {
  const sync = readFileSync(new URL("../scripts/sync.ts", import.meta.url), "utf8");
  const backup = readFileSync(new URL("../scripts/backup.ts", import.meta.url), "utf8");

  it("**同步走 runSteps** —— 它每两分钟一轮，是整站数据的唯一来源", () => {
    assert.match(sync, /runSteps\(/);
    for (const name of ["刷新群列表", "同步消息", "群成员名册", "人员名录"]) {
      assert.ok(sync.includes(`name: "${name}"`), `${name} 不在同步这一轮里`);
    }
  });

  it("**刷新群列表失败不该让消息同步也不跑** —— 上游抖一下就会发生", () => {
    // 两者都在 runSteps 的数组里，就自动隔开了
    const stepsBlock = sync.slice(sync.indexOf("runSteps("), sync.indexOf("] as never)"));
    assert.ok(stepsBlock.includes("刷新群列表"));
    assert.ok(stepsBlock.includes("同步消息"));
  });

  it("备份把「推异地」标成非致命", () => {
    const offsiteBlock = backup.slice(backup.indexOf('name: "推异地"'), backup.indexOf('name: "恢复演练"'));
    assert.match(offsiteBlock, /critical: false/);
  });

  it("本机备份那一段**不在** runSteps 里 —— 它失败就该直接退出，没有下一步可谈", () => {
    assert.ok(backup.indexOf("source.backup") < backup.indexOf("runSteps("));
  });
});

describe("**package.json 里的脚本都得真的能跑**", () => {
  /*
   * `db:migrate` 曾经指向 scripts/migrate.ts，而那个文件根本不存在 ——
   * 真正跑迁移的是 bootstrap。这种条目是个陷阱:
   * 照着 package.json 敲一遍命令,得到的是一句
   * 「Cannot find module」,而人第一反应是「我的环境坏了」。
   */
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string>;
  };

  it("每个引用了 scripts/*.ts 的命令，那个文件都要存在", () => {
    const missing: string[] = [];
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      for (const match of cmd.matchAll(/(scripts\/[\w-]+\.ts)/g)) {
        if (!existsSync(new URL(`../${match[1]}`, import.meta.url))) {
          missing.push(`${name} → ${match[1]}`);
        }
      }
    }
    assert.deepEqual(missing, [], "package.json 里这些命令跑不起来");
  });
});
