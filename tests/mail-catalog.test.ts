import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { matchDomain } from "@/lib/mail/claim-matching";
import {
  CATALOG,
  CONFIRMED_PAIRS,
  DOMAIN_EXPIRES_AT,
  OWNER_DOMAINS,
  SUBSTITUTES,
  defaultsFor,
  isPunycodeSane,
  resolveFlags,
  toPunycode,
} from "@/lib/mail/domain-catalog";

/**
 * 域名目录。
 *
 * 这一组测试盯的是**清单本身**，不是代码逻辑 —— 因为这份清单
 * 会被人手改（新买域名、改分类、改档位），而改错的后果分两种：
 * 少一个域名只是它收不到信；**多给一类权限则是把一个不该发的地址发出去**。
 */

const byDomain = new Map(CATALOG.map((e) => [e.domain, e]));

describe("清单完整性", () => {
  it("正好 100 个，没有重复", () => {
    assert.equal(CATALOG.length, 100);
    assert.equal(new Set(CATALOG.map((e) => e.domain)).size, 100);
  });

  it("全是 .icu，且都是小写", () => {
    for (const e of CATALOG) {
      assert.ok(e.domain.endsWith(".icu"), `${e.domain} 不是 .icu`);
      assert.equal(e.domain, e.domain.toLowerCase(), `${e.domain} 有大写`);
    }
  });

  it("各类的数量对得上设计文档", () => {
    const count = (kind: string) => CATALOG.filter((e) => e.kind === kind).length;
    /*
     * 8-13 之后的分法（清单上的，不是跑完种子的）：
     *   owned    30 = 28 个有主 + 站长自己的 2 个
     *   reserved 44 = 22 个靓号 + 22 个「看起来是给某人的」（含 cliproxyapi）
     *   temp     15 = 原来 14 个 + babycam
     *   admin    11 = 10 商标 + 余承东（配 MX、收信，但只有管理员能开地址）
     *   blocked   0 = 现在一个都没有
     */
    assert.equal(count("owned"), 30);
    assert.equal(count("reserved"), 44);
    assert.equal(count("temp"), 15);
    assert.equal(count("admin"), 11);
    assert.equal(count("blocked"), 0);
  });

  it("待匹配的那 22 个都标了 pendingOwner", () => {
    const pending = CATALOG.filter((e) => e.pendingOwner);
    assert.equal(pending.length, 22);
    // 匹配不上时它们留在原地，所以那一格必须是能落脚的公共池
    for (const e of pending) {
      assert.equal(e.kind, "reserved", `${e.domain} 匹配不上时会留在 ${e.kind}`);
    }
  });

  it("靓号必须有档位，别的必须没有", () => {
    for (const e of CATALOG) {
      if (e.kind === "reserved") assert.ok(e.tier, `${e.domain} 缺档位`);
      else assert.equal(e.tier, undefined, `${e.domain} 不该有档位`);
    }
  });

  it("封禁和管理员专用的每一个都要写清楚为什么 —— 半年后一定有人问", () => {
    for (const e of CATALOG.filter((x) => x.kind === "blocked" || x.kind === "admin")) {
      assert.ok(e.note && e.note.length > 4, `${e.domain} 没写理由`);
    }
  });
});

describe("★ 靓号池永远不跑一次性箱", () => {
  it("这是靓号值钱的全部原因，不许被一条覆盖打破", () => {
    for (const e of CATALOG.filter((x) => x.kind === "reserved")) {
      assert.equal(
        resolveFlags(e).allowBurner,
        false,
        `${e.domain} 开了一次性箱 —— 花 400 分买的地址会跟着被拉黑`,
      );
    }
  });

  it("一次性池反过来必须真的跑一次性箱，否则它没有存在意义", () => {
    for (const e of CATALOG.filter((x) => x.kind === "temp")) {
      assert.equal(resolveFlags(e).allowBurner, true, `${e.domain}`);
    }
  });
});

describe("★ 管理员专用和封禁：普通成员一个口子都没有", () => {
  it("两类都不能开一次性箱、不能被申领、没有 catch-all", () => {
    for (const e of CATALOG.filter((x) => x.kind === "blocked" || x.kind === "admin")) {
      const f = resolveFlags(e);
      assert.equal(f.allowBurner, false, `${e.domain}`);
      assert.equal(f.allowClaim, false, `${e.domain}`);
      assert.equal(f.catchAll, false, `${e.domain}`);
      assert.equal(f.allowCustomLocal, false, `${e.domain}`);
    }
  });

  it("★ 商标那 11 个是 admin 不是 blocked —— 差别在收不收信", () => {
    /*
     * 站长 8-14：配 MX，但不进池子。
     * 收信换来的是**看得见有人在试探** —— 每一次投递都进 mail_ingress_log，
     * 而 blocked（连 MX 都不配）那些尝试连痕迹都不留。
     */
    for (const d of [
      "githubusercontent.icu",
      "huggingface.icu",
      "airtable.icu",
      "opencart.icu",
      "openreview.icu",
      "moonshot48.icu",
      "claudex.icu",
      "bilibill.icu",
      "dgxspark.icu",
      "adventurex.icu",
      "余承东.icu",
    ]) {
      assert.equal(byDomain.get(d)?.kind, "admin", d);
    }
  });

  it("cliproxyapi 由站长放开申请，但落在靓号池不是一次性池", () => {
    /*
     * CLIProxyAPI 是真实存在的开源项目。靓号池至少意味着拿到它的是
     * 一个认得出是谁、花了积分、全程留痕的成员 ——
     * 万一那个项目的作者找上门，我们答得出是谁在用。
     */
    const e = byDomain.get("cliproxyapi.icu");
    assert.equal(e?.kind, "reserved");
    assert.equal(resolveFlags(e!).allowBurner, false);
  });
});

describe("站长挪进一次性池的五个", () => {
  const moved = ["马嘉祺.icu", "华立.icu", "teensintimes.icu", "camhub.icu", "babycam.icu"];

  it("确实在一次性池里", () => {
    for (const d of moved) assert.equal(byDomain.get(d)?.kind, "temp", d);
  });

  it("★ 但不许自选前缀、不许申领", () => {
    // 自选前缀 + 这几个域名，组合出来的地址才是有杀伤力的那种；
    // 随机的 12 位串没有这个问题
    for (const d of moved) {
      const f = resolveFlags(byDomain.get(d)!);
      assert.equal(f.allowCustomLocal, false, `${d} 不该允许自选前缀`);
      assert.equal(f.allowClaim, false, `${d} 不该允许长期申领`);
    }
  });
});

describe("中文域名", () => {
  const idn = CATALOG.filter((e) => !/^[a-z0-9.-]+$/.test(e.domain));

  it("清单里有 5 个", () => {
    assert.equal(idn.length, 5);
  });

  it("到期日是同一天 —— 同一批买的", () => {
    assert.equal(new Date(DOMAIN_EXPIRES_AT).toISOString().slice(0, 10), "2027-08-08");
  });

  it("都转得出 punycode", () => {
    for (const e of idn) {
      const p = toPunycode(e.domain);
      assert.ok(p.startsWith("xn--"), `${e.domain} → ${p}`);
      assert.equal(isPunycodeSane(e.domain, p), true, e.domain);
    }
  });

  it("★ 进了一次性池的中文域名都不在随机轮换里", () => {
    // 很多网站的注册表单直接拒收 IDN 邮箱，而一次性箱的全部用途
    // 就是去那些表单里注册 —— 默认发一个用不了的地址是最糟的第一印象
    for (const e of idn.filter((x) => x.kind === "temp")) {
      assert.equal(resolveFlags(e).inRandomRotation, false, e.domain);
    }
  });

  it("至少还有一个 ASCII 域名留在随机轮换里，否则随机开箱会开不出来", () => {
    const rotation = CATALOG.filter((e) => e.kind === "temp" && resolveFlags(e).inRandomRotation);
    assert.ok(rotation.length >= 5, `随机轮换只剩 ${rotation.length} 个`);
    for (const e of rotation) {
      assert.match(e.domain, /^[a-z0-9.-]+$/, `${e.domain} 是 IDN，不该在轮换里`);
    }
  });
});

describe("punycode 转换", () => {
  it("ASCII 域名转出来和自己相同", () => {
    assert.equal(toPunycode("Example.ICU"), "example.icu");
    assert.equal(isPunycodeSane("example.icu", "example.icu"), true);
  });

  it("已知的几个中文域名转出来是对的", () => {
    assert.equal(toPunycode("华立.icu"), "xn--xkrw23g.icu");
    assert.equal(toPunycode("马嘉祺.icu"), "xn--w4rs83f4sw.icu");
    assert.equal(toPunycode("云上耀斑.icu"), "xn--fhqrmz20dmfy.icu");
  });

  it("最长的那个中文域名也转得动", () => {
    const p = toPunycode("我真的特别特别特别特别特别想你.icu");
    assert.equal(p, "xn--6qqw1eaaaa206xh6b9z6dbabbb595logc.icu");
    // A 标签每段上限 63 —— 超了 DNS 层面就是无效的
    assert.ok(p.split(".")[0].length <= 63);
  });

  it("**转不动时不静默通过** —— 转错的域名会表现成「收不到信」而没有报错", () => {
    assert.equal(isPunycodeSane("华立.icu", "华立.icu"), false);
  });
});

describe("站长人工确认的配对", () => {
  it("四条都指向清单里真实存在、且是 owned 的域名", () => {
    for (const [domain, paired] of Object.entries(CONFIRMED_PAIRS)) {
      assert.ok(byDomain.has(domain), `${domain} 不在清单里`);
      assert.equal(byDomain.get(domain)?.pendingOwner, true, `${domain} 该是待匹配的那一批`);
      assert.equal(byDomain.get(paired)?.kind, "owned", `${paired} 得是个有主域名`);
    }
  });

  it("★ 写的是域名→域名，不是域名→人名", () => {
    // 人从库里查（谁拥有配对的那个），所以他改昵称、换账号都不影响
    for (const paired of Object.values(CONFIRMED_PAIRS)) {
      assert.match(paired, /\.icu$/, `${paired} 看起来不是个域名`);
    }
  });

  it("★ 这四个确实是匹配器挡下来的 —— 否则这张表就是多余的", () => {
    // 表里躺着一条匹配器本来就能算出来的，说明有人在用它绕过规则
    const candidates = Object.entries(CONFIRMED_PAIRS).map(([, paired]) => ({
      userId: "01U_PAIRED",
      handle: paired.replace(/\.icu$/, ""),
      source: "claimed-domain" as const,
    }));
    for (const domain of Object.keys(CONFIRMED_PAIRS)) {
      assert.equal(matchDomain(domain, candidates), null, `${domain} 匹配器自己就能算出来`);
    }
  });
});

describe("有主域名与替代品", () => {
  it("站长自己的两个走的是和别人一样的 owned 路径", () => {
    for (const d of OWNER_DOMAINS) {
      assert.equal(byDomain.get(d)?.kind, "owned", d);
      // 自有域名那条路径的第一个用户就是站长本人 —— catch-all 必须是开的
      assert.equal(resolveFlags(byDomain.get(d)!).catchAll, true, d);
    }
  });

  it("替代品表里的目标域名确实在清单里，且是 owned", () => {
    for (const [failed, replacement] of Object.entries(SUBSTITUTES)) {
      assert.ok(!byDomain.has(failed), `${failed} 不该在清单里 —— 它没买到`);
      assert.equal(byDomain.get(replacement)?.kind, "owned", replacement);
    }
  });

  it("owned 默认开 catch-all —— 「任意别名」靠的就是它", () => {
    assert.equal(defaultsFor("owned").catchAll, true);
  });
});
