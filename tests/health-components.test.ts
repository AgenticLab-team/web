import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

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

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

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
