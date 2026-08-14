import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  MAIL_PROTOCOL_MIN,
  MAIL_PROTOCOL_VERSION,
  protocolAcceptable,
} from "@/lib/mail/protocol";

/**
 * 网关 ↔ 站点的线上协议。
 *
 * ═════════════════════════════════════════
 * 这是整个邮箱模块里唯一一条「会静默断掉」的缝
 * ═════════════════════════════════════════
 *
 * 别处的错都在同一个进程里，类型检查兜得住。而网关是
 * **独立部署**的：它可以是上周那份代码，跑在另一台机器上。
 * 两边的字段名一旦分叉，表现是「有些信收不到」，
 * 而两边的日志都显示一切正常。
 *
 * 所以这里逐条比对源码 —— 网关是 .mjs，类型检查管不到它。
 */

const gateway = readFileSync(
  new URL("../ops/mail-gateway/gateway.mjs", import.meta.url),
  "utf8",
);

describe("版本号两边对得上", () => {
  it("网关里写死的 PROTOCOL 等于站点的当前版本", () => {
    const m = /const PROTOCOL = (\d+);/.exec(gateway);
    assert.ok(m, "网关里找不到 PROTOCOL —— 是不是被删了？");
    assert.equal(
      Number(m[1]),
      MAIL_PROTOCOL_VERSION,
      "改了协议版本要两边一起改，否则升级站点那一刻网关全部失效",
    );
  });

  it("最老支持版本不高于当前版本", () => {
    assert.ok(MAIL_PROTOCOL_MIN <= MAIL_PROTOCOL_VERSION);
  });
});

describe("兼容判定", () => {
  it("当前版本认", () => {
    assert.equal(protocolAcceptable(MAIL_PROTOCOL_VERSION), true);
  });

  it("★ 不带版本号的当成第一版 —— 老网关手上正压着信", () => {
    // 判成不兼容的话，升级站点那一刻所有还没升级的网关全部失效
    assert.equal(protocolAcceptable(undefined), true);
    assert.equal(protocolAcceptable(null), true);
  });

  it("比站点新的不认 —— 那意味着站点该升级了，而不是尽力解析", () => {
    assert.equal(protocolAcceptable(MAIL_PROTOCOL_VERSION + 1), false);
  });

  it("不是整数的一律不认", () => {
    for (const bad of ["abc", 1.5, {}, [], true]) {
      assert.equal(protocolAcceptable(bad), false, String(bad));
    }
  });
});

describe("网关发的字段，站点都认识", () => {
  /*
   * 从网关源码里把 push() 那个对象字面量的键抠出来，
   * 和 `InboundMessage` 的字段比。
   *
   * 比源码而不是比类型：网关是 .mjs，`tsc` 根本不看它 ——
   * 也就是说**这条缝上没有任何类型检查**，只有这一条测试。
   */
  const pushBlock = /await push\(\s*\{([\s\S]*?)\n {12}\},/.exec(gateway);

  it("抠得出 push 的字段 —— 抠不出来这条测试就是在空转", () => {
    assert.ok(pushBlock, "解析退化了：改了 gateway.mjs 的缩进？");
  });

  it("★ 每个字段站点那边都有对应", () => {
    const keys = [...(pushBlock?.[1] ?? "").matchAll(/^\s{14}(\w+):/gm)].map((m) => m[1]);
    assert.ok(keys.length > 8, `只抠出 ${keys.length} 个字段，解析八成退化了`);

    /*
     * 站点那一侧的字段清单。手写而不是从类型反射 ——
     * TS 的类型在运行期不存在，而这条测试要的就是「有人改了接口
     * 却没改网关」时红一下。手写一份逼着改动的人两边都看一眼。
     */
    const known = new Set([
      "protocol",
      "envelopeFrom",
      "envelopeTo",
      "rfcMessageId",
      "inReplyTo",
      "from",
      "fromName",
      "subject",
      "text",
      "html",
      "size",
      "attachments",
      "spamScore",
      "spfPass",
      "dkimPass",
      "dmarcPass",
      "sourceIp",
    ]);

    const unknown = keys.filter((k) => !known.has(k));
    assert.deepEqual(unknown, [], `网关发了站点不认识的字段：${unknown.join("、")}`);
  });

  it("两个必填字段网关一定发", () => {
    const keys = [...(pushBlock?.[1] ?? "").matchAll(/^\s{14}(\w+):/gm)].map((m) => m[1]);
    for (const required of ["envelopeFrom", "envelopeTo"]) {
      assert.ok(keys.includes(required), `网关没发 ${required}，站点会一律回 400`);
    }
  });
});

describe("网关的几条判断不许被顺手改掉", () => {
  it("★ RCPT 阶段拒的是 5xx，不是 4xx", () => {
    // 4xx 是「等会儿再来」，发信方会重试好几天，而答案永远一样
    assert.match(gateway, /550 5\.1\.2/, "域名不认识那条");
    assert.match(gateway, /550 5\.1\.1/, "地址不存在那条");
  });

  it("★ 投递失败回 451（临时），让对方重投", () => {
    // 回 5xx 这封信就永远没了，而问题多半在我们这边
    assert.match(gateway, /451 4\.3\.0/);
  });

  it("★ 不做中继：AUTH 整个禁掉", () => {
    assert.match(gateway, /disabledCommands:\s*\["AUTH"\]/);
  });

  it("★ 路由表拉不到时不清空", () => {
    // 清空的话，站点一次几分钟的重启会让网关在这期间拒收所有的信
    assert.doesNotMatch(gateway, /snapshot\s*=\s*\{\s*domains:\s*new Map\(\),\s*at:\s*Date\.now/);
  });
});
