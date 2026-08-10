import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { stripComments as strip } from "./_source";

/**
 * 健康探测的组件状态。
 *
 * ─────────────────────────────────────────
 * `frp_tunnel` 会永远卡在 down
 * ─────────────────────────────────────────
 *
 * 老写法是：探测失败且判定为上游不可达 → 写 `frp_tunnel: down`；
 * 探测成功 → 写 `upstream_api: ok`。
 *
 * 也就是说**没有任何一条路径会把 `frp_tunnel` 写回 ok**。
 * 隧道断过一次之后那一行永远停在 down，而站点总状态取最差的组件 ——
 * 于是隧道恢复了、消息也照常同步了，首页和 `/api/health`
 * 仍然一直说「down」。站长报的正是这个。
 *
 * 这比一个没做的功能糟：它让健康状态**变成一个学会撒谎的仪表盘**。
 * 看过两次「明明好了还说坏」之后，真出事那次也不会有人信。
 */

const health = readFileSync(new URL("../src/lib/health.ts", import.meta.url), "utf8");

/** 把 probeUpstream 那一段切出来（到下一个 export function 为止） */
function probeSource(): string {
  const start = health.indexOf("export async function probeUpstream");
  assert.notEqual(start, -1, "找不到 probeUpstream");
  const rest = health.slice(start + 10);
  const end = rest.indexOf("\nexport ");
  return rest.slice(0, end === -1 ? undefined : end);
}

describe("**每一条路径都要给两个组件各写一个状态**", () => {
  const body = strip(probeSource());

  it("成功和失败两条路径都在", () => {
    assert.match(body, /try \{/);
    assert.match(body, /catch/);
  });

  it("**每个 return 都同时带上 frp_tunnel 和 upstream_api**", () => {
    /*
     * 这是这个文件的全部意义。少写一个组件不会报错、
     * 不会有任何测试变红，只会让那个组件的状态**停在上一次的值上** ——
     * 而停在 down 上的那次没有人查得出来。
     */
    const returns = body.split("return ").slice(1);
    assert.ok(returns.length >= 2, "至少该有成功和失败两条 return");

    for (const [i, chunk] of returns.entries()) {
      // 只看这个 return 到下一个 return 之前的那一段
      assert.match(chunk, /"frp_tunnel"/, `第 ${i + 1} 个 return 没写 frp_tunnel`);
      assert.match(chunk, /"upstream_api"/, `第 ${i + 1} 个 return 没写 upstream_api`);
    }
  });

  it("**没有那个二选一的三元表达式了**", () => {
    // `component: down ? "frp_tunnel" : "upstream_api"` 正是病根
    assert.equal(
      /component:\s*\w+\s*\?\s*"frp_tunnel"\s*:\s*"upstream_api"/.test(body),
      false,
      "还在按条件二选一地写组件名",
    );
  });

  it("隧道不通时 upstream_api 也算 down —— 探不到不能算 ok", () => {
    /*
     * 隧道断的时候我们对那头的 API 一无所知。
     * 「不知道」在健康检查里只能算坏 ——
     * 标成 ok 是在替一个探不到的东西打包票。
     */
    assert.match(body, /探不到/);
  });

  it("**隧道通、但 API 报错时要分得开**", () => {
    /*
     * 这一分就是这两个组件存在的全部意义：区分
     * 「家里那台机器没连上来」和「机器连上来了但 NekoBot 出错了」——
     * 这两件事要做的处理完全不同。
     */
    assert.match(body, /tunnelDown \? "down" : "ok"/);
  });

  it("返回的是数组 —— 一次探测两条记录", () => {
    assert.match(health, /export async function probeUpstream\(\): Promise<HealthReport\[\]>/);
  });

  it("汇总的时候摊平进去，不是当成一条塞进数组", () => {
    // 写成 `await probeUpstream()` 不加展开的话，落库时 component 是 undefined
    assert.match(strip(health), /\.\.\.\(await probeUpstream\(\)\)/);
  });
});

describe("读回来的是每个组件最新的那一行", () => {
  it("按组件分区取最新 —— 不然一条历史的 down 会一直压着", () => {
    assert.match(health, /PARTITION BY component ORDER BY checked_at DESC/);
  });
});

describe("**GitHub 生态：关着的时候要说得出来**", () => {
  /*
   * 「不配就整个消失」是对的设计（半套配置更糟：按钮照常出现、
   * 点下去走到一半才在 GitHub 那边失败，用户会以为是自己的问题）。
   *
   * 但它安静到**站长看不出这一整块是关着的**。线上实测：
   * 绑定 0 人、仓库缓存 0 条 —— 不是没人想用，是入口根本没出现过，
   * 而后台任何一处都没说这件事。
   *
   * 一个「做了但没人看得见」的功能和没做，唯一的区别就是
   * 有没有一个地方说得出它是关着的。
   */
  const body = strip(health);

  it("有这一项探测，而且进了那一轮", () => {
    assert.match(body, /export function probeGithub\(\)/);
    assert.match(body, /probeGithub\(\),/);
  });

  it("**没配时是 degraded，不是 down**", () => {
    /*
     * 站长可能就是不想接 GitHub。报成 down 会让总状态一直红着，
     * 而一个一直红着的仪表盘会让真出事那次也没人看 ——
     * 和上面 frp 那次是同一个道理。
     */
    const fn = body.slice(body.indexOf("export function probeGithub"));
    const stop = fn.indexOf("\nexport ");
    const seg = stop === -1 ? fn : fn.slice(0, stop);
    assert.equal(seg.includes('status: "down"'), false, "没配被报成了故障");
    assert.match(seg, /status: "degraded"/);
  });

  it("**说得出缺哪几个环境变量** —— 只说「没配」等于让人去翻代码", () => {
    assert.match(body, /GITHUB_CLIENT_ID/);
  });

  it("配了但没人绑，也要说一句 —— 那多半是入口埋得太深", () => {
    assert.match(body, /还没有人绑定/);
  });

  it("**组件名在 schema 的枚举里** —— 不在的话这一行写不进库", () => {
    const schema = readFileSync(
      new URL("../src/lib/db/schema/system.ts", import.meta.url),
      "utf8",
    );
    assert.match(schema, /"github",/);
  });
});
