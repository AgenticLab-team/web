import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { clientIp, UNKNOWN_IP } from "@/lib/request";

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { readCode } from "./_source";

const SRC = join(process.cwd(), "src");

/** 走一遍 src 下所有 ts/tsx —— 和 tests/dead-columns.test.ts 同一种走法 */
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(full);
  }
  return out;
}

/**
 * 客户端 IP 是从哪个头来的 —— 以及拿不到时会怎样。
 *
 * ═════════════════════════════════════════
 * 两个头，可信程度差一整个量级
 * ═════════════════════════════════════════
 *
 *   · `X-Real-IP $remote_addr` —— `proxy_set_header` **覆盖**客户端
 *     发来的同名头，值来自 TCP 对端。伪造不了。
 *   · `X-Forwarded-For $proxy_add_x_forwarded_for` —— 这个是**追加**：
 *     客户端自己发的那串留在前面，nginx 把对端接在后面。
 *     而按惯例读 XFF 就是读第一段 —— 也就是客户端写的那一段。
 *
 * 原来的顺序是先 XFF 再 X-Real-IP，等于优先相信客户端填的值。
 *
 * 一直没出事是因为 Cloudflare 在最前面会覆写 XFF（三条路径都实测过）。
 * 但 2026-08-14 按站长要求撤掉了「80/443 只许 CF 访问」那道防火墙，
 * 源站现在直接暴露在公网上 —— **「谁在 nginx 前面」不再是这段代码
 * 能假设的事**。
 *
 * 所以这一组钉的不是某个正在发生的漏洞，是那个**假设**。
 */

const req = (headers: Record<string, string>) =>
  new Request("https://agenticlab.sh/", { headers });

describe("**先信 X-Real-IP，再退回 XFF**", () => {
  it("两个都有时用 X-Real-IP", () => {
    /*
     * 这是最要紧的一条：攻击者能控制 XFF 的第一段，控制不了 X-Real-IP。
     * 顺序反过来的话，他随手换个头就换了一个限流配额桶。
     */
    const ip = clientIp(req({ "x-real-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9, 1.2.3.4" }));
    assert.equal(ip, "1.2.3.4", "用了客户端可以伪造的那个头");
  });

  it("只有 XFF 时退回它的第一段", () => {
    assert.equal(clientIp(req({ "x-forwarded-for": "9.9.9.9, 1.2.3.4" })), "9.9.9.9");
  });

  it("**两个都没有时给哨兵值**，不是 undefined", () => {
    /*
     * 返回 undefined 的话，下游那句 `if (!ip) return null` 就成立了 ——
     * 而那句话的意思是「不限流」。见下面那一组。
     */
    assert.equal(clientIp(req({})), UNKNOWN_IP);
  });

  it("空字符串当作没有 —— 不能拿空串当一个配额桶", () => {
    assert.equal(clientIp(req({ "x-real-ip": "   " })), UNKNOWN_IP);
  });
});

describe("**限流失效的方向只能是误伤，不能是没闸**", () => {
  for (const file of ["lib/auth/ratelimit.ts", "lib/tui/device-ratelimit.ts"]) {
    it(`${file} 里没有「拿不到 IP 就放行」`, () => {
      /*
       * 两个限流器原来开头都是 `if (!ip) return null`。
       *
       * 那句话的失效方向是**开着的**：只要有一天这两个头都没有
       * （换个反向代理、加一层网关、有人直连 node 的端口），
       * 全站按 IP 的限流一起消失，而没有任何地方会报错 ——
       * 后台看起来一切正常，限流器每次都返回「没超」。
       *
       * 用 readCode（去注释）：上面那几段注释里正写着这句话长什么样。
       */
      const body = readCode(file);
      assert.equal(
        /if\s*\(\s*!\s*ip\s*\)\s*return\s+null/.test(body),
        false,
        `${file} 又回到「拿不到 IP 就不限流」了`,
      );
    });
  }

  it("device/start 那条尤其不能失效 —— 它是唯一未鉴权就能写库的公网端点", () => {
    /*
     * 设备码流程本来就从「没有凭证」开始，所以它必须未鉴权可调。
     * 限流是它唯一的闸：不限的话 `device_codes` 会被灌大，
     * 而表一大，生成用户码撞车的概率跟着涨 ——
     * 症状是**一个毫不相干的人偶尔登录失败**。
     */
    const route = readCode("app/api/v1/auth/device/start/route.ts");
    assert.match(route, /tooManyDeviceStarts\(/, "限流调用没了");
    assert.equal(
      /clientIp\(request\)\s*\?\?\s*null/.test(route),
      false,
      "又把 IP 兜成 null 了 —— 那正好喂给限流器的失效分支",
    );
  });
});

describe("**取 IP 只有一份实现**", () => {
  it("审计上下文走 clientIp，不自己抄一遍", () => {
    /*
     * `lib/audit.ts` 里原来有第二份，而且顺序一样是反的。
     * 两份同样的错，改一份不改另一份的后果是：
     * **限流按真 IP 算、审计日志记的是伪造值** —— 而那种不一致
     * 没有任何人看得出来，直到有人拿着日志去追一件事。
     */
    const audit = readCode("lib/audit.ts");
    assert.match(audit, /actorIp:\s*clientIp\(request\)/);
    assert.equal(
      audit.includes('headers.get("x-forwarded-for")'),
      false,
      "audit.ts 又自己读了一遍 XFF",
    );
  });

  it("**全仓库只有 request.ts 直接读这两个头**", () => {
    /*
     * 反方向也扫一遍。少了这条的话，下一个需要 IP 的地方
     * 还是会就地写一行 `headers.get("x-forwarded-for")` ——
     * 那一行看起来完全正常，而它绕开了上面所有的判断。
     */
    const offenders: string[] = [];
    for (const full of walk(SRC)) {
      const rel = full.slice(SRC.length + 1);
      if (rel === "lib/request.ts") continue;
      if (/headers\.get\("x-(forwarded-for|real-ip)"\)/.test(readCode(rel))) offenders.push(rel);
    }
    assert.deepEqual(offenders, [], "这些文件绕开了 clientIp() 自己读头");
  });
});
