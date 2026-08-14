import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { ENDPOINTS } from "@/lib/api-tokens/catalog";
import { SCOPE_KEYS } from "@/lib/api-tokens/rules";
import { ADMIN_SECTION_META } from "@/lib/admin/api-section-rules";
import { ADMIN_NAV } from "@/lib/admin/nav";
import { ALL_NAV_ITEMS } from "@/lib/nav";
import { SURFACES, declaredEndpoints, surfaceForWebPath } from "@/lib/tui/surface";

/**
 * 终端客户端和网页的对齐守卫。
 *
 * ═════════════════════════════════════════
 * 它守的不是「现在对不对」，是「三个月后还对不对」
 * ═════════════════════════════════════════
 *
 * 第一版交付那天，终端里当然有网页上的每一样东西 —— 那是刚做完的。
 * 真正会出事的是之后：网页加了一个板块，而终端那边没有人记得跟。
 *
 * 那种退化**没有任何症状**。终端照常能跑、能看群聊、能发帖，
 * 只是新板块在里面根本不存在 —— 而用终端的人压根不知道网页上多了什么，
 * 所以没有人会来报这个问题。
 *
 * 这和 `ARCHITECTURE.md` 第二节讲的死开关是同一种病，
 * 也只有同一种治法：把它变成红的。
 */

const ROOT = new URL("..", import.meta.url).pathname;

/**
 * 剥掉 Go 的注释。
 *
 * 只剥**行首**的 `//`（前面只有空白），和整段的 `/* … *\/`。
 * 行中间的 `//` 绝大多数时候是 URL 里那两个斜杠
 * （`https://…`），把它当注释会吃掉半行代码 ——
 * 而那正是 `tests/_source.ts` 顶上记的那个坑。
 */
function stripGoComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => (/^\s*\/\//.test(line) ? "" : line))
    .join("\n");
}

/** 网页上真实存在的页面路由，从文件系统反推 —— 不是维护第二份清单 */
function webRoutes(): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        /*
         * 路由组 `(app)` 不出现在 URL 里。
         * 不剥掉的话每一条路由都会带上 `/(app)`，
         * 于是这份守卫会把**每一个页面**都报成缺失 ——
         * 一条把所有东西都报红的守卫，下场是被整个注释掉。
         */
        const seg = /^\(.*\)$/.test(e.name) ? prefix : `${prefix}/${e.name}`;
        walk(join(dir, e.name), seg);
      } else if (e.name === "page.tsx") {
        out.push(prefix === "" ? "/" : prefix);
      }
    }
  };
  walk(join(ROOT, "src/app"), "");
  return out.sort();
}

describe("**网页上的每一页，终端里都要有人想过怎么办**", () => {
  const declared = new Set(SURFACES.map((s) => s.web).filter(Boolean) as string[]);

  for (const route of webRoutes()) {
    it(route, () => {
      assert.ok(
        declared.has(route),
        `${route} 不在 src/lib/tui/surface.ts 里。\n` +
          `加一行。终端里不做也可以（tui: null + why），但不能没想过 —— ` +
          `一个没人想过的缺口不会有任何症状。`,
      );
    });
  }

  it("**反过来也不许有幽灵** —— 表里写着的网页路由必须真的存在", () => {
    /*
     * 页面删掉而表里那一行留着的话，终端会一直挂着一个
     * 打开就报错的入口 —— 而表面上「对齐得很好」。
     */
    const real = new Set(webRoutes());
    const ghosts = SURFACES.filter((s) => s.web && !real.has(s.web)).map((s) => `${s.key} → ${s.web}`);
    assert.deepEqual(ghosts, [], "这些面指向的网页已经没了");
  });
});

describe("**导航里的每一项，终端里都要有对应的分区**", () => {
  /*
   * 上面那条守的是页面，这条守的是**入口**。
   *
   * 两者不是一回事：`lib/nav.ts` 里一项可能对着好几个页面
   * （「群聊」底下是回看/检索/资源库/雷达四个），
   * 而只查页面的话，一个新加的导航项如果复用了已有页面，
   * 会安静地通过 —— 但终端最左那一竖里少了一格。
   */
  for (const item of ALL_NAV_ITEMS.filter((i) => i.ready)) {
    it(`${item.label}（${item.href}）`, () => {
      const s = surfaceForWebPath(item.href);
      assert.ok(s, `导航项 ${item.key} 指向 ${item.href}，但 surface.ts 里没有对应的面`);
      assert.ok(
        s.tui !== null,
        `${item.key} 是导航上的一级入口，而终端里标着不做（${s.why ?? "没写理由"}）—— ` +
          `导航上有的东西不该在终端里整个消失`,
      );
    });
  }
});

describe("**不做也要说得出为什么**", () => {
  for (const s of SURFACES.filter((x) => x.tui === null)) {
    it(s.key, () => {
      assert.ok(
        s.why && s.why.length >= 10,
        `${s.key} 标着终端里不做，但没写理由。` +
          `一个没有理由的缺口，六个月后没有人敢补 —— 因为不知道当初为什么不做。`,
      );
    });
  }
});

describe("**表里声明的端点必须真的在开放 API 目录里**", () => {
  /*
   * 防的是「终端屏幕做出来了，但它调的接口其实没上线」。
   *
   * 这种错在开发机上不会暴露：写 Go 那侧的人对着这张表写客户端，
   * 一切看起来都对，直到真的连上线上服务才拿回一片 404。
   */
  const known = new Set(ENDPOINTS.map((e) => `${e.method} ${e.path}`));

  for (const ep of declaredEndpoints()) {
    it(ep, () => {
      assert.ok(known.has(ep), `${ep} 被 surface.ts 引用，但 lib/api-tokens/catalog.ts 里没有`);
    });
  }
});

describe("**开放 API 目录里的每一条，也要有面用到它**", () => {
  it("没有孤儿端点", () => {
    /*
     * 反方向：一个谁也没用的端点意味着两种可能 ——
     * 要么它该被删，要么**终端漏做了一个面**。
     * 两种都值得当场知道，而不是等到有人问「这个接口是干嘛的」。
     */
    const used = new Set(declaredEndpoints());
    const orphans = ENDPOINTS.map((e) => `${e.method} ${e.path}`).filter((e) => !used.has(e));
    assert.deepEqual(orphans, [], "这些端点没有任何一个面用到 —— 要么删，要么终端漏做了");
  });
});

describe("表本身的形状", () => {
  it("key 不重复 —— 它是审计和跳转的标识", () => {
    const keys = SURFACES.map((s) => s.key);
    assert.equal(new Set(keys).size, keys.length, "有重复的 key");
  });

  it("屏幕 id 不重复 —— 两个面指向同一个屏幕等于其中一个打不开", () => {
    const ids = SURFACES.map((s) => s.tui).filter(Boolean);
    assert.equal(new Set(ids).size, ids.length, "有重复的屏幕 id");
  });

  it("scope 都是真的存在的", () => {
    for (const s of SURFACES) {
      for (const k of s.scopes) {
        assert.ok(SCOPE_KEYS.includes(k), `${s.key} 要一个不存在的 scope：${k}`);
      }
    }
  });

  it("**写操作的面要声明写 scope** —— 否则终端会拿一把只读令牌去点提交", () => {
    /*
     * 症状很坏：界面上按钮好好的，按下去拿回 403，
     * 而人会以为是自己没权限，不是令牌少了一项。
     * 提前声明才能在他动手**之前**就说清楚。
     *
     * 声明在 `scopes` 还是 `optionalScopes` 是一个真实的产品决定：
     *   · `scopes`         → 缺了就打不开这一屏
     *   · `optionalScopes` → 屏照常打开，那个动作显示成一句解释
     *
     * 群聊是后者（大多数人没有 `groups:send`，但都要看群聊），
     * 发帖是前者（不能发帖的人进「发帖」屏没有任何意义）。
     * 这条守卫不替人做这个选择，只要求**必须选一个**。
     */
    const writeMethods = /^(POST|PATCH|DELETE) /;
    for (const s of SURFACES) {
      const declared = new Set([...s.scopes, ...(s.optionalScopes ?? [])]);
      const needed = s.api
        .filter((a) => writeMethods.test(a))
        .flatMap((a) => ENDPOINTS.find((e) => `${e.method} ${e.path}` === a)?.scopes ?? []);
      for (const n of needed) {
        assert.ok(
          declared.has(n),
          `${s.key} 上有写操作要 ${n}，而这个面既没把它放进 scopes（缺了就打不开），` +
            `也没放进 optionalScopes（缺了只是这个动作不可用）—— 必须选一个`,
        );
      }
    }
  });

  it("**`optionalScopes` 不许和 `scopes` 重复** —— 一项只能有一种含义", () => {
    /*
     * 两边都写的话，「缺了会怎样」这个问题有两个互相矛盾的答案，
     * 而终端那侧只会读到其中一个。
     */
    for (const s of SURFACES) {
      const dup = (s.optionalScopes ?? []).filter((k) => s.scopes.includes(k));
      assert.deepEqual(dup, [], `${s.key} 的 ${dup.join("、")} 同时出现在两栏里`);
    }
  });
});

describe("**后台导航里的每一页，注册表里都要有一个分区**", () => {
  /*
   * 前面那几条守的是前台。后台是另一套导航（`lib/admin/nav.ts`），
   * 而它底下有三十页 —— 三十页共用同一对端点，靠 `adminSection` 区分。
   *
   * 没有这一条的话，后台加一页只会让终端里少一个分区，
   * 而所有前台的守卫都是绿的。
   */
  const sections = new Set(ADMIN_SECTION_META.map((s) => s.key));
  const byWeb = new Map(SURFACES.filter((s) => s.web).map((s) => [s.web as string, s]));

  for (const item of ADMIN_NAV.flatMap((s) => s.items).filter((i) => i.ready)) {
    it(`${item.label}（${item.href}）`, () => {
      const surface = byWeb.get(item.href);
      assert.ok(surface, `后台导航项 ${item.key} 指向 ${item.href}，surface.ts 里没有这一行`);
      assert.ok(
        surface.adminSection,
        `${surface.key} 是后台页，但没写 adminSection —— 终端不知道该调哪个分区`,
      );
      assert.ok(
        sections.has(surface.adminSection),
        `${surface.key} 指向的分区「${surface.adminSection}」不在 lib/admin/api-registry.ts 里 —— ` +
          `终端里那一屏点进去会是空的，而表面上「对齐得很好」`,
      );
    });
  }

  it("**反过来：注册表里也不许有导航外的分区**", () => {
    /*
     * 一个没有后台页对应的分区意味着它没有任何人能审 ——
     * 而它照样能被令牌调用。
     */
    const declared = new Set(
      SURFACES.map((s) => s.adminSection).filter(Boolean) as string[],
    );
    const extra = ADMIN_SECTION_META.map((s) => s.key).filter((k) => !declared.has(k));
    assert.deepEqual(extra, [], "注册表里这些分区在 surface.ts 里没有对应的面");
  });

  it("**几个不可逆的动作必须标了 danger ≥ 2**", () => {
    /*
     * 危险级 >=2 的动作在路由那一层会被要求显式 `confirm`。
     * 标漏了的话，一个「封禁」会和「加备注」一样一按就生效。
     *
     * 这里只钉住几个**不可逆或影响面极大**的，
     * 而不是替每个动作判一遍 —— 后者会变成一张要跟着改的清单。
     *
     * 读的是**源码**而不是 import 那份注册表：注册表拖着整个
     * 数据库和上游客户端，而这是一条纯结构的测试 ——
     * 让它因为没配环境变量而挂掉，下一个人只会把它删掉。
     */
    const src = readFileSync(join(ROOT, "src/lib/admin/api-registry.ts"), "utf8");
    for (const actionKey of ["set_status", "queue_send", "run_prune", "revoke_all_ssh_tokens"]) {
      const at = src.indexOf(`key: "${actionKey}"`);
      assert.ok(at > 0, `${actionKey} 不见了`);
      /* 从这个动作起，到下一个动作开始之前，必须出现 danger: 2 或更高 */
      const nextAt = src.indexOf('key: "', at + 10);
      const block = src.slice(at, nextAt > 0 ? nextAt : at + 2000);
      assert.match(block, /danger: [2-9]/, `${actionKey} 是不可逆的动作，danger 要 >= 2`);
    }
  });

});

describe("**声明要用的端点，Go 那侧真的在调**", () => {
  /*
   * ═════════════════════════════════════════
   * 这一条抓的是「屏做出来了，但功能少一半」
   * ═════════════════════════════════════════
   *
   * 前面那些守卫查的是「有没有这一屏」。而一屏存在**不等于**
   * 它做到了那一屏该做的事：
   *
   * `forum.post` 声明它要 8 个端点（读、回复、表情、投票、
   * 采纳、举报、打赏、收藏）。只实现了「读」的话，
   * 那一屏照样打得开、照样在导航里、所有守卫全绿 ——
   * 而它少了七件事。
   *
   * 这种缺失是**没有症状**的：用终端的人不知道网页上那一屏
   * 还能干什么。而这恰恰是这整套东西要防的东西。
   *
   * ─────────────────────────────────────────
   * 它是按路径前缀搜的，所以只能证明「调过」
   * ─────────────────────────────────────────
   *
   * 搜到 `/posts/` + `/react` 只说明代码里出现过那个调用，
   * 不说明它接对了参数。这条守卫不假装能证明后者 ——
   * 它要抓的是「整块没做」，而那是唯一会真实发生的那种。
   */
  /**
   * Go 那侧每个文件的**代码**，注释已经剥掉。
   *
   * ═════════════════════════════════════════
   * 两件事必须同时做对，否则这条守卫会骗人
   * ═════════════════════════════════════════
   *
   * **① 注释要剥掉。** 那些文件里的注释大量提到端点路径
   * （「读消息走 searchMessages」「见 /api/v1/admin/sections」）——
   * 不剥的话，一条只在注释里被提到过的端点会被判成「已经接上了」。
   * 这个仓库在这一类错上踩过三次，`tests/_source.ts` 顶上记着。
   *
   * **② 按文件存，不是拼成一大坨。** 判「这个端点被调过吗」要求
   * 路径和调用方法出现在**同一个文件**里 —— 拼成一坨的话，
   * A 文件里的 `.Post(` 会给 B 文件里的路径作证。
   */
  const goFiles = (() => {
    const dir = join(ROOT, "tui/internal");
    const byName = new Map<string, string>();
    const walk = (d: string) => {
      if (!existsSync(d)) return;
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const f = join(d, e.name);
        if (e.isDirectory()) walk(f);
        else if (e.name.endsWith(".go") && !e.name.endsWith("_test.go")) {
          byName.set(e.name, stripGoComments(readFileSync(f, "utf8")));
        }
      }
    };
    walk(dir);

    /*
     * ─────────────────────────────────────────
     * 通用屏那三个文件算**一个**单元
     * ─────────────────────────────────────────
     *
     * 大多数屏共用一套实现，而它按职责拆成了三个文件：
     *
     *   · `registry.go` —— 路径和动作的声明（`spec{path: …}`）
     *   · `generic.go`  —— 读那一半（`.Get(`）
     *   · `action.go`   —— 写那一半（`.Post(` / `.Delete(`）
     *
     * 这是那个设计的核心：六十来屏不各写一遍取数据和提交的代码。
     *
     * 按文件分开判的话，这三个互相都「缺一半」，于是这条守卫会把
     * 每一个通用屏都报成没接上 —— 而一条把所有东西都报红的守卫，
     * 下场是被整个注释掉。
     */
    const GENERIC_UNIT = ["registry.go", "generic.go", "action.go"];
    const generic = GENERIC_UNIT.map((n) => byName.get(n) ?? "").join("\n");
    const out = [generic];
    for (const [name, src] of byName) {
      if (GENERIC_UNIT.includes(name)) continue;
      out.push(src);
    }
    return out;
  })();

  it("扫到了 Go 源码 —— 扫不到的话这条测试是在空转", () => {
    const total = goFiles.join("").length;
    assert.ok(goFiles.length > 5, `只扫到 ${goFiles.length} 个 Go 文件`);
    assert.ok(total > 20_000, `剥掉注释后只剩 ${total} 字节 —— 剥得太狠了`);
  });

  /*
   * 这些端点**故意**没有被终端调用，每一条都要说得出为什么。
   *
   * 不列名单的话，只有两条路：要么这条守卫报一堆假警然后被删掉，
   * 要么把断言放松到抓不住东西。
   */
  /*
   * 这些端点**故意**没有被终端调用，每一条都要说得出为什么。
   *
   * 不列名单的话，只有两条路：要么这条守卫报一堆假警然后被删掉，
   * 要么把断言放松到抓不住东西。
   *
   * 名单越短越好 —— 它每一条都是「网页能做而终端不能」的一件事。
   */
  const INTENTIONALLY_UNUSED: Record<string, string> = {
    "GET /api/v1/docs":
      "动态 API 文档是给写脚本的人看的。终端里那一屏（me/tokens）列的是令牌本身，" +
      "而「我这把能干什么」在最右那一栏上按 scope 逐条画着 —— 比一份文档更贴",
    "POST /api/v1/me/export":
      "同上。这份文件里有别人在群里说的话，而它一旦落到硬盘上就收不回来 —— " +
      "所以那一步刻意留在浏览器里，让人在按之前真的看见那句话",
  };

  /**
   * 一个端点在 Go 那侧有没有被真的调过。
   *
   * 要求**同一个文件里**同时出现：
   *   · 路径的固定前缀（`/api/v1/posts/`）
   *   · 占位符之后那一段（`/react`）—— 否则「读一篇帖子」
   *     会给「给帖子加表情」作证，两者路径前缀一样
   *   · 对应的客户端方法（`.Post(` / `.Get(` / …）—— 否则
   *     同一个路径上的 GET 会给 POST 作证，而那是**两件事**：
   *     隐私开关能读到不等于能拨动
   */
  const methodCall: Record<string, string[]> = {
    /*
     * GET 有两种调法：普通的 `.Get(`，和 SSE 那条长连接
     * （`api.Stream(`）—— 后者底下也是一个 GET，
     * 只是它不走带超时的那个 http.Client（一条 SSE 就是要挂着不动）。
     *
     * 只认 `.Get(` 的话，通知实时流会被永远报成「没接上」，
     * 而它明明在跑 —— 那种假警会让人去删这条守卫。
     */
    GET: [".Get(", "api.Stream("],
    POST: [".Post("],
    PATCH: [".Patch("],
    DELETE: [".Delete("],
  };

  const hasCall = (src: string, method: string) =>
    methodCall[method].some((c) => src.includes(c));

  const called = (endpoint: string): boolean => {
    const [method, path] = endpoint.split(" ");

    /*
     * ─────────────────────────────────────────
     * 写操作要认**声明**，不能只认「这个文件里有 .Post(」
     * ─────────────────────────────────────────
     *
     * 通用屏那三个文件算一个单元，而那个单元里既有 `.Get(` 也有
     * `.Post(`，还有几十条路径。只要「路径在 + 方法在」的话，
     * 一条**只被读过**的路径会因为同一个单元里别的动作用了 POST
     * 而被判成「写也接上了」。
     *
     * `/api/v1/me/export` 就是这样：终端只读得到它的预览，
     * 而真正的导出刻意留在网页上 —— 但松的判法会说它已经做了。
     *
     * 所以写操作按 `action{…}` 里那对 `method` + `path` 认。
     */
    if (method !== "GET") {
      const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const declared = new RegExp(`method:\\s*"${method}",\\s*path:\\s*"${escaped}"`);
      /* 手写那几屏不走声明式动作，所以再认一次「路径 + 对应方法」 */
      const prefix = path.split("{")[0];
      const tail = path.includes("}") ? (path.split("}").pop() ?? "") : "";
      return goFiles.some(
        (src) =>
          declared.test(src) ||
          (src.includes(prefix) &&
            (tail === "" || src.includes(tail)) &&
            hasCall(src, method) &&
            !src.includes("genericFactory(")),
      );
    }

    const prefix = path.split("{")[0];
    const tail = path.includes("}") ? (path.split("}").pop() ?? "") : "";
    return goFiles.some(
      (src) =>
        src.includes(prefix) &&
        (tail === "" || src.includes(tail)) &&
        hasCall(src, method),
    );
  };

  for (const s of SURFACES.filter((x) => x.tui !== null)) {
    for (const endpoint of s.api) {
      it(`${s.key} → ${endpoint}`, () => {
        if (called(endpoint)) return;
        const why = INTENTIONALLY_UNUSED[endpoint];
        assert.ok(
          why,
          `${s.key} 声明它要 ${endpoint}，而 Go 那侧一次都没调过。\n` +
            `要么接上，要么写进 INTENTIONALLY_UNUSED 并说清楚为什么 ——\n` +
            `一屏「打得开但少一半功能」是这套东西最没有症状的退化方式。`,
        );
        assert.ok(why.length > 15, `${endpoint} 的理由太短了，说不清`);
      });
    }
  }

  it("**名单不能过期** —— 接上了就要从名单上划掉", () => {
    /*
     * 反方向：接上了却忘了划掉的话，下一个人读到的是
     * 「这个还没做」—— 而它已经做了。而更糟的是，
     * 那一条从此不再被这条守卫覆盖。
     */
    const stale = Object.keys(INTENTIONALLY_UNUSED).filter(called);
    assert.deepEqual(stale, [], "这些已经接上了，从 INTENTIONALLY_UNUSED 里划掉");
  });
});

describe("**倒给 Go 的那份数据是最新的**", () => {
  /*
   * ═════════════════════════════════════════
   * 改了表却忘了重新生成，是这套东西最安静的一种坏法
   * ═════════════════════════════════════════
   *
   * `surface.gen.go` 是 `npm run tui:gen` 从 `surface.ts` 倒过去的。
   * 忘了跑那条命令的话：TS 这侧的守卫全绿（它读的是真源），
   * 而终端里少一格 —— 因为它读的是那份旧的生成物。
   *
   * 这里不重跑生成器（那要拖起整个服务端依赖），只核对
   * **每个屏幕 id 和每个后台分区都在生成物里**。
   * 那已经足以抓住「加了一行忘了生成」，
   * 而那正是唯一会真实发生的那种。
   */
  const gen = join(ROOT, "tui/internal/surface/surface.gen.go");

  it("生成物在", () => {
    assert.ok(existsSync(gen), "找不到 tui/internal/surface/surface.gen.go —— 跑一下 npm run tui:gen");
  });

  it("每个面都倒过去了", () => {
    if (!existsSync(gen)) return;
    const body = readFileSync(gen, "utf8");
    const missing = SURFACES.filter((s) => !body.includes(`Key:            ${JSON.stringify(s.key)}`)).map(
      (s) => s.key,
    );
    assert.deepEqual(missing, [], "这些面还没倒给 Go —— 跑一下 npm run tui:gen");
  });

  it("每个后台分区也倒过去了", () => {
    if (!existsSync(gen)) return;
    const body = readFileSync(gen, "utf8");
    const missing = ADMIN_SECTION_META.filter(
      (s) => !body.includes(`{Key: ${JSON.stringify(s.key)},`),
    ).map((s) => s.key);
    assert.deepEqual(missing, [], "这些后台分区还没倒给 Go —— 跑一下 npm run tui:gen");
  });

  it("**生成物里也不许有表外的面** —— 那是删了一行却没重新生成", () => {
    if (!existsSync(gen)) return;
    const body = readFileSync(gen, "utf8");
    const declared = new Set(SURFACES.map((s) => s.key));
    const inGen = [...body.matchAll(/Key:\s+"([\w.-]+)",/g)].map((m) => m[1]);
    const stale = inGen.filter((k) => k.includes(".") && !declared.has(k));
    assert.deepEqual(stale, [], "生成物里还留着已经删掉的面 —— 跑一下 npm run tui:gen");
  });
});

describe("**Go 那侧真的注册了这些屏幕**", () => {
  /*
   * 前面几条都在 TypeScript 这一侧自说自话：表里写了屏幕 id，
   * 而那个 id 在 Go 那边是不是真的存在，没有任何东西核对过。
   *
   * 缺了这条的话，这整份守卫只能保证「有人填过表」，
   * 保证不了「终端里真的有这个屏幕」—— 而后者才是它的全部意义。
   *
   * 核对方式是读 Go 那侧的注册表源码。跨语言只能这么做，
   * 但它比不核对好得多：id 写错一个字母当场就红。
   */
  const registry = join(ROOT, "tui/internal/ui/screens/registry.go");

  it("注册表文件在", () => {
    assert.ok(
      existsSync(registry),
      "找不到 tui/internal/ui/screens/registry.go —— 终端那侧的屏幕注册表是这份守卫的另一半",
    );
  });

  it("每个屏幕 id 都在注册表里", () => {
    if (!existsSync(registry)) return;
    const body = readFileSync(registry, "utf8");
    const missing = SURFACES.filter((s) => s.tui && !body.includes(`"${s.tui}"`)).map((s) => s.tui);
    assert.deepEqual(missing, [], "这些屏幕在表里声明了，但 Go 那侧没注册");
  });

  it("**注册表里也不许有表外的屏幕**", () => {
    if (!existsSync(registry)) return;
    const body = readFileSync(registry, "utf8");
    const declared = new Set(SURFACES.map((s) => s.tui).filter(Boolean));

    /*
     * ─────────────────────────────────────────
     * 只认两处：`Register("…")`，和 `adminScreenIDs` 那个数组
     * ─────────────────────────────────────────
     *
     * 后台那三十屏是**循环注册**的（它们共用一个实现），
     * 所以只认 `Register("…")` 的话，那三十个 id 一个都看不见 ——
     * 于是这条守卫对整个后台失效，而它看起来是绿的。
     *
     * 但反过来把范围放宽到「所有形如 a/b 的字符串」也不行：
     * 那会把表单字段的标签（`Label: "owner/name"`）当成屏幕 id，
     * 于是这条守卫开始报一个不存在的屏 ——
     * 而人的第一反应是去 surface.ts 里加一行假的。
     *
     * 所以两处都精确地取。
     */
    const adminBlock = (() => {
      const at = body.indexOf("adminScreenIDs = []string{");
      if (at < 0) return "";
      return body.slice(at, body.indexOf("}", at));
    })();
    assert.ok(adminBlock.length > 100, "找不到 adminScreenIDs 那个数组 —— 后台那三十屏就没被覆盖到");

    const ids = [
      ...[...body.matchAll(/Register\(\s*"([\w/-]+)"/g)].map((m) => m[1]),
      ...[...adminBlock.matchAll(/"([\w/-]+)"/g)].map((m) => m[1]),
    ];

    assert.ok(ids.length > 40, `只从注册表里认出 ${ids.length} 个屏幕 id —— 正则八成退化了`);
    const extra = [...new Set(ids)].filter((id) => !declared.has(id));
    assert.deepEqual(extra, [], "Go 那侧注册了表里没有的屏幕 —— 它不会被任何守卫覆盖到");
  });
});
