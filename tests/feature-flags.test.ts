import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  FLAGS,
  FLAG_KEYS,
  bucketOf,
  defaultEnabled,
  evaluate,
  isGatedPath,
  specOf,
  type FlagRow,
} from "@/lib/flags/registry";
import { DEFAULT_FLAGS } from "@/lib/settings/defaults";
import { NAV, navItemVisible } from "@/lib/nav";

/**
 * 功能开关。
 *
 * ─────────────────────────────────────────
 * 十个开关，一个调用点都没有
 * ─────────────────────────────────────────
 *
 * `feature_flags` 表里躺着十行，`isFeatureEnabled` 全站零引用 ——
 * 生产上 `keyword_radar` 和 `shop` 都写着「关」，而那两个页面
 * 照常打得开、照常挂在导航里。
 *
 * schema 上那句注释写着「出问题时先关模块，而不是回滚整站」，
 * 而真出事那一刻去关它，会发现什么都不会发生。
 * 一个只在紧急情况下才会被用到的机制，也只有在紧急情况下
 * 才会被发现是假的。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

const guest = { userId: null, roleKeys: [] };
const member = { userId: "u1", roleKeys: ["member"] };
const admin = { userId: "u2", roleKeys: ["member", "admin"] };

const row = (over: Partial<FlagRow> = {}): FlagRow => ({
  key: "forum",
  enabled: true,
  rollout: "all",
  rolloutValue: null,
  ...over,
});

describe("**总闸优先于灰度**", () => {
  it("关了就是关了，rollout 不再看", () => {
    /*
     * 反过来的话，「关掉」这个动作对灰度里的人不生效 ——
     * 而那正是最需要它生效的时候（出事时先关模块）。
     */
    const off = row({ enabled: false, rollout: "percent", rolloutValue: { percent: 100 } });
    assert.equal(evaluate(off, admin, "forum"), false);
    assert.equal(evaluate(off, member, "forum"), false);
  });

  it("开着 + all —— 谁都能用，包括访客", () => {
    assert.equal(evaluate(row(), guest, "forum"), true);
  });
});

describe("按身份灰度", () => {
  const r = row({ rollout: "role", rolloutValue: { roles: ["admin"] } });

  it("有那个身份的能用", () => {
    assert.equal(evaluate(r, admin, "forum"), true);
  });

  it("没有的不能", () => {
    assert.equal(evaluate(r, member, "forum"), false);
  });

  it("**访客一律不在灰度里** —— 他们没有任何身份", () => {
    assert.equal(evaluate(r, guest, "forum"), false);
  });

  it("**没填身份 = 谁都进不去**，不是谁都能进", () => {
    /*
     * 一个「按身份放行、但没填身份」的配置，更可能是填了一半，
     * 而不是想放给所有人。放行的话，一次填错会让本想收窄的开关变成全开。
     */
    const empty = row({ rollout: "role", rolloutValue: { roles: [] } });
    assert.equal(evaluate(empty, admin, "forum"), false);
  });

  it("配置坏了也不炸", () => {
    for (const bad of [null, "x", 42, { roles: "admin" }, { roles: [1, 2] }]) {
      assert.equal(evaluate(row({ rollout: "role", rolloutValue: bad }), admin, "forum"), false);
    }
  });
});

describe("按人灰度", () => {
  it("名单里的能用，别人不能", () => {
    const r = row({ rollout: "user", rolloutValue: { users: ["u1"] } });
    assert.equal(evaluate(r, member, "forum"), true);
    assert.equal(evaluate(r, admin, "forum"), false);
    assert.equal(evaluate(r, guest, "forum"), false);
  });
});

describe("按比例灰度", () => {
  it("0% 谁都没有，100% 都有", () => {
    assert.equal(evaluate(row({ rollout: "percent", rolloutValue: { percent: 0 } }), member, "forum"), false);
    assert.equal(evaluate(row({ rollout: "percent", rolloutValue: { percent: 100 } }), member, "forum"), true);
  });

  it("**同一个人得到的答案永远一样** —— 否则功能会一会儿有一会儿没有", () => {
    const r = row({ rollout: "percent", rolloutValue: { percent: 50 } });
    const first = evaluate(r, member, "forum");
    for (let i = 0; i < 20; i++) {
      assert.equal(evaluate(r, member, "forum"), first);
    }
  });

  it("**不同开关的 20% 是不同的 20%** —— 否则同一批人撞上每一次灰度", () => {
    const a = bucketOf("u1", "forum");
    const b = bucketOf("u1", "shop");
    assert.notEqual(a, b);
  });

  it("散列摊得开 —— 一千个人不该全挤在同一格", () => {
    const buckets = new Set(
      Array.from({ length: 1000 }, (_, i) => bucketOf(`user-${i}`, "forum")),
    );
    assert.ok(buckets.size > 50, `只落到 ${buckets.size} 个桶`);
  });

  it("大致按比例 —— 20% 落在 12%~28% 之间就算对", () => {
    const hit = Array.from({ length: 2000 }, (_, i) => bucketOf(`u${i}`, "forum") < 20).filter(
      Boolean,
    ).length;
    const pct = (hit / 2000) * 100;
    assert.ok(pct > 12 && pct < 28, `实际 ${pct.toFixed(1)}%`);
  });

  it("**访客不算在内** —— 没有稳定身份，按比例放行会变成「刷新一下就有了」", () => {
    assert.equal(evaluate(row({ rollout: "percent", rolloutValue: { percent: 99 } }), guest, "forum"), false);
  });
});

describe("**库里查不到时按什么算**", () => {
  it("已经做完的默认开着，没做的默认关着", () => {
    /*
     * 原来的实现是 `?? false`。一个还没跑 seed 的新环境、
     * 或者一次把表清空的事故，会让整站功能同时消失 ——
     * 而看起来像是代码坏了，没人会想到去看一张空表。
     */
    assert.equal(defaultEnabled("forum"), true);
    assert.equal(defaultEnabled("shop"), true);
    assert.equal(defaultEnabled("rag_qa"), false);
  });

  it("清单外的 key 一律关 —— 拼错一个字不该放行任何东西", () => {
    assert.equal(defaultEnabled("forumm"), false);
    assert.equal(evaluate(undefined, admin, "不存在的开关"), false);
  });

  it("空库时 evaluate 走默认值", () => {
    assert.equal(evaluate(undefined, guest, "forum"), true);
    assert.equal(evaluate(undefined, guest, "rag_qa"), false);
  });
});

describe("**清单要说清楚每个开关管着什么**", () => {
  it("每一条都有一句「关掉会发生什么」", () => {
    /*
     * 只写一个名字和一个滑块的话，按下去之前没人知道自己关掉的是哪些页面 ——
     * 于是这一页会变成没人敢碰的地方，而它本来是出事时第一个该来的地方。
     */
    for (const f of FLAGS) {
      assert.ok(f.effect.length > 8, `${f.key} 没说清楚`);
      assert.ok(f.label.length > 0);
    }
  });

  it("**没接线的开关要标出来** —— 否则这一页自己就成了新的死开关", () => {
    const planned = FLAGS.filter((f) => f.status === "planned").map((f) => f.key);
    // 这三个对应的功能确实还没做
    for (const k of ["rag_qa", "temp_mailbox", "external_users"]) {
      assert.ok(planned.includes(k), `${k} 该标成 planned`);
    }
  });

  it("接了线的都指得出自己管哪个导航项", () => {
    for (const f of FLAGS.filter((x) => x.status === "wired")) {
      assert.ok(f.navKeys && f.navKeys.length > 0, `${f.key} 没说管哪个入口`);
    }
  });

  it("**清单里的 navKey 在 NAV 里真的存在** —— 打错一个字的表现是那个开关永远不生效", () => {
    const navKeys = new Set(NAV.flatMap((s) => s.items.map((i) => i.key)));
    for (const f of FLAGS) {
      for (const k of f.navKeys ?? []) {
        assert.ok(navKeys.has(k), `${f.key} 指向了不存在的导航项 ${k}`);
      }
    }
  });

  it("**NAV 里的 flag 也要在清单里** —— 反向也不能漏", () => {
    for (const section of NAV) {
      for (const item of section.items) {
        if (!item.flag) continue;
        assert.ok(FLAG_KEYS.includes(item.flag), `导航项 ${item.key} 指向了不存在的开关 ${item.flag}`);
      }
    }
  });

  it("种子里的初值和清单一致 —— 两份对不上会让新环境和生产长得不一样", () => {
    for (const seed of DEFAULT_FLAGS) {
      const spec = specOf(seed.key);
      assert.ok(spec, `种子里有清单外的 ${seed.key}`);
      assert.equal(
        seed.enabled,
        spec!.status === "wired",
        `${seed.key} 的初值和 status 对不上`,
      );
    }
  });
});

describe("**后台永远不受开关管**", () => {
  it("/admin、/login、/join、/api 一律不拦", () => {
    /*
     * 一个能把管理后台关掉的开关，按错一次就再也打不开了 ——
     * 而唯一能重新打开它的地方，正是刚被关掉的那一页。
     */
    for (const p of ["/admin", "/admin/flags", "/login", "/join", "/api/health"]) {
      assert.equal(isGatedPath(p), false, `${p} 被开关管着`);
    }
  });

  it("普通页面照管", () => {
    for (const p of ["/forum", "/shop", "/radar"]) {
      assert.equal(isGatedPath(p), true);
    }
  });

  it("**没有任何开关指向后台的导航项**", () => {
    const adminItem = NAV.flatMap((s) => s.items).find((i) => i.key === "admin");
    assert.ok(adminItem);
    assert.equal(adminItem!.flag, undefined, "后台入口被开关管着了");
  });
});

describe("导航", () => {
  const ctx = (enabled: boolean) => ({
    loggedIn: true,
    hasPermission: () => true,
    featureEnabled: () => enabled,
  });

  it("关掉之后那一项不出现", () => {
    const forum = NAV.flatMap((s) => s.items).find((i) => i.key === "forum")!;
    assert.equal(navItemVisible(forum, ctx(true)), true);
    assert.equal(navItemVisible(forum, ctx(false)), false);
  });

  it("没有 flag 的项不受影响", () => {
    const me = NAV.flatMap((s) => s.items).find((i) => i.key === "me")!;
    assert.equal(navItemVisible(me, ctx(false)), true);
  });

  it("**不传 featureEnabled 时当全开** —— 忘了传不该让整个导航空掉", () => {
    const forum = NAV.flatMap((s) => s.items).find((i) => i.key === "forum")!;
    assert.equal(navItemVisible(forum, { loggedIn: true, hasPermission: () => true }), true);
  });
});

describe("**拦在页面里，不只是藏导航**", () => {
  const gated: [string, string][] = [
    ["app/(app)/forum/page.tsx", "forum"],
    ["app/(app)/forum/[board]/page.tsx", "forum"],
    ["app/(app)/forum/p/[id]/page.tsx", "forum"],
    ["app/(app)/forum/new/page.tsx", "forum"],
    ["app/(app)/search/page.tsx", "message_search"],
    ["app/(app)/links/page.tsx", "link_library"],
    ["app/(app)/radar/page.tsx", "keyword_radar"],
    ["app/(app)/shop/page.tsx", "shop"],
    ["app/(app)/activities/page.tsx", "events"],
  ];

  for (const [file, flag] of gated) {
    it(`${file} 挡住了`, () => {
      /*
       * 只把导航项藏起来的话，地址栏里敲一下照样进得去 ——
       * 那不是开关，是把门牌摘了。
       */
      assert.match(src(file), new RegExp(`requireFeature\\("${flag}"`), `${file} 没挡`);
    });
  }

  it("**状态码会是 200 而内容是 404** —— 这是流式渲染的已知代价，不是漏了", () => {
    /*
     * (app) 下有 loading.tsx，外壳先流式发出去，响应头在 notFound()
     * 抛出之前就写好了。proxy.ts 顶上记的是同一件事的另一半。
     * 那边能靠中间件解决，这边不能：判定要读库，而中间件读不到。
     *
     * 保证在内容那一层 —— 生产上验过关掉之后页面里一条真实内容都不剩。
     */
    const server = src("lib/flags/server.ts");
    assert.match(server, /状态码会是 200/);
    assert.match(server, /loading\.tsx/);
  });

  it("给 404 而不是「此功能已关闭」", () => {
    /*
     * 后者会告诉不该知道的人「这里本来有个东西」，
     * 而关模块的场景里，往往正是不想让人来试。
     */
    const server = strip(src("lib/flags/server.ts"));
    assert.match(server, /notFound\(\)/);
    assert.doesNotMatch(server, /已关闭|暂不可用/);
  });

  it("**管理员也一样挡** —— 否则关掉之后自己看到的仍然是正常的", () => {
    const server = src("lib/flags/server.ts");
    const fn = server.slice(server.indexOf("export function requireFeature"));
    assert.doesNotMatch(fn.slice(0, 300), /canModerate|isAdmin|system\./);
  });
});

describe("接线", () => {
  it("**老的那份 isFeatureEnabled 删掉了** —— 两份判定早晚有一处被改、另一处没改", () => {
    const store = src("lib/settings/store.ts");
    assert.doesNotMatch(store, /export function isFeatureEnabled/);
    assert.doesNotMatch(store, /flagCache/);
  });

  it("改完清缓存 —— 忘了清的话「关掉」要等重启才生效", () => {
    const actions = strip(src("lib/flags/actions.ts"));
    assert.match(actions, /invalidateFlagCache\(\)/);
    // 开关管的是导航和一批页面，只 revalidate 后台那一页不够
    assert.match(actions, /revalidatePath\("\/", "layout"\)/);
  });

  it("只认清单里的 key —— 允许写清单外的等于让人配一个永不生效的开关", () => {
    const actions = strip(src("lib/flags/actions.ts"));
    assert.match(actions, /if \(!spec\) return fail/);
  });

  it("改动进审计", () => {
    assert.match(strip(src("lib/flags/actions.ts")), /action: "system\.flag\.set"/);
  });

  it("库里有、清单里没有的会被点出来 —— 改了没反应会让人怀疑整个机制", () => {
    assert.match(src("lib/flags/server.ts"), /export function orphanFlagKeys/);
    assert.match(src("components/admin/FlagList.tsx"), /清单外的开关/);
  });

  it("后台有入口", () => {
    assert.match(src("lib/admin/nav.ts"), /href: "\/admin\/flags"/);
    assert.match(src("components/admin/AdminNav.tsx"), /"toggle-left": ToggleLeft/);
  });

  it("规则层不碰数据库", () => {
    const code = src("lib/flags/registry.ts");
    for (const forbidden of ["server-only", "@/lib/db", "drizzle-orm"]) {
      assert.equal(code.includes(forbidden), false, `规则层引了 ${forbidden}`);
    }
  });
});
