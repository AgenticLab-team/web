import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  PREVIEW_DELEGATES,
  PREVIEW_EXEMPT,
  delegatesGuard,
  previewGaps,
} from "@/lib/audit/preview-coverage";

/**
 * 预览态写入拦截的覆盖检查。
 *
 * 漏一个的后果不是「少拦一次」——
 * 是管理员以别人的身份写了数据，而审计日志记在**被预览的人**头上。
 * 从那以后这个站的审计日志一条都不能信，
 * 因为你无法区分「他真的做了」和「有人以他的身份做了」。
 */

const root = new URL("../src", import.meta.url).pathname;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith(".ts") || full.endsWith(".tsx") ? [full] : [];
  });
}

const files = walk(root).map((f) => ({
  path: path.relative(root, f),
  source: readFileSync(f, "utf8"),
}));

/**
 * 断言代码时要先把注释去掉。
 *
 * 不去的话这些检查会被**自己的说明文字**骗过去：
 * 那段代码的注释里写着「不能用 getCurrentUser」，
 * 而检查器看到 getCurrentUser 就报错 —— 越是把原因写清楚的地方越容易误报。
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
}

describe("每个后台写操作都拦了预览态", () => {
  it("**一个都不许漏**", () => {
    const gaps = files.flatMap((f) => previewGaps(f.path, f.source));

    assert.deepEqual(
      gaps.map((g) => `${g.file}:${g.line} ${g.fn}`),
      [],
      "这些函数会写数据但没拦预览态 —— 预览时点下去会真的写，而且记在被预览的人头上",
    );
  });

  it("检查器不是空转的 —— 它确实扫到了东西", () => {
    /*
     * 一个永远返回空数组的检查器和没有检查器一样，
     * 而它看起来还更让人放心。所以要证明它真的在看：
     * 造一个明显有问题的函数，它必须报出来。
     */
    const bad = `
      export async function doBadThing(input: { id: string }) {
        const ctx = await requireAdmin("system.settings");
        db.update(users).set({ status: "banned" }).run();
        audit(ctx, { action: "x" });
      }
    `;
    const gaps = previewGaps("fake.ts", bad);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].fn, "doBadThing");
  });

  it("加了拦截的就放过", () => {
    const good = `
      export async function doGoodThing(input: { id: string }) {
        await assertNotPreviewing();
        const ctx = await requireAdmin("system.settings");
        db.update(users).set({ status: "banned" }).run();
      }
    `;
    assert.deepEqual(previewGaps("fake.ts", good), []);
  });

  it("**扫描范围真的覆盖了那批 action 文件** —— 否则「0 个缺口」毫无意义", () => {
    for (const expected of [
      "lib/admin/user-actions.ts",
      "lib/broadcast/actions.ts",
      "lib/shop/actions.ts",
      "lib/titles/actions.ts",
    ]) {
      assert.ok(
        files.some((f) => f.path === expected),
        `${expected} 不在扫描范围里`,
      );
    }
  });
});

describe("委托与豁免这两张表本身", () => {
  it("**委托的名字真的存在** —— 写错一个就等于发了张永久豁免", () => {
    const all = files.map((f) => f.source).join("\n");
    for (const name of PREVIEW_DELEGATES) {
      assert.match(
        all,
        new RegExp(`function\\s+${name}\\b`),
        `委托表里的 ${name} 在代码里根本不存在`,
      );
    }
  });

  it("**委托的函数真的会拦** —— 不然委托出去等于没拦", () => {
    const guard = files.find((f) => f.path === "lib/admin/guard.ts")!;
    for (const name of PREVIEW_DELEGATES) {
      const start = guard.source.indexOf(`function ${name}`);
      assert.notEqual(start, -1, `${name} 不在 guard.ts 里`);
      assert.match(
        guard.source.slice(start, start + 400),
        /assertNotPreviewing\(/,
        `${name} 被当成委托，但它自己不拦预览态`,
      );
    }
  });

  it("delegatesGuard 认得出委托调用", () => {
    assert.equal(delegatesGuard("await requireWritableAdmin('x')"), "requireWritableAdmin");
    assert.equal(delegatesGuard("await requireAdmin('x')"), null);
  });

  it("**豁免只有预览的进出两个** —— 别的都不该在这里", () => {
    /*
     * 退出预览是个写操作（要把那一行标成结束），而它当然发生在预览态里。
     * 拦住它人就永远出不去了 —— 一个进得去出不来的预览态，
     * 比没有这个功能危险得多。
     *
     * 除此之外任何名字进这张表都要过这一条：豁免是静默的，
     * 它不报错，只是从此不再检查那一片。
     */
    assert.deepEqual([...PREVIEW_EXEMPT].sort(), ["exitPreviewAction", "startPreviewAction"]);
  });

  it("退出预览这条路没有任何前置条件", () => {
    const src = code(files.find((f) => f.path === "lib/rbac/preview-actions.ts")!.source);
    const exit = src.slice(src.indexOf("function exitPreviewAction"));
    assert.doesNotMatch(exit, /requireAdmin\(/, "退出预览需要权限 —— 权限被撤之后就出不来了");
    assert.doesNotMatch(exit, /assertNotPreviewing\(/, "退出预览拦住了预览态 —— 那就是出不去");
  });
});

describe("身份入口只有一个", () => {
  it("**预览接在 getCurrentUser 里** —— 接在别处就会有页面切了视角、有页面没切", () => {
    const session = code(files.find((f) => f.path === "lib/auth/session.ts")!.source);
    const fn = session.slice(
      session.indexOf("function getCurrentUser"),
      session.indexOf("function currentPreview"),
    );
    assert.match(fn, /resolvePreview\(/);
  });

  it("**开预览用的是真身份** —— 用 getCurrentUser 的话预览会自己给自己发令牌", () => {
    const src = code(files.find((f) => f.path === "lib/rbac/preview-actions.ts")!.source);
    const start = src.slice(
      src.indexOf("function startPreviewAction"),
      src.indexOf("function exitPreviewAction"),
    );
    assert.match(start, /getRealUser\(/);
    assert.doesNotMatch(start, /getCurrentUser\(/, "拿被预览的人当 viewer 了，会一层层漂移下去");
  });

  it("横幅挂在最外层布局上 —— 每一页都要有", () => {
    const layout = files.find((f) => f.path === "app/(app)/layout.tsx")!.source;
    assert.match(layout, /<PreviewBanner\s*\/>/);
  });

  it("**横幅没有关闭按钮** —— 它只在人忘了自己在预览时才起作用，而那时它已经被关掉了", () => {
    const banner = code(files.find((f) => f.path === "components/admin/PreviewBanner.tsx")!.source);
    for (const forbidden of ["dismiss", "关闭", "useState"]) {
      assert.equal(banner.includes(forbidden), false, `横幅里出现了 ${forbidden}`);
    }
  });

  it("横幅会显示扣掉了哪几项权限", () => {
    const banner = files.find((f) => f.path === "components/admin/PreviewBanner.tsx")!.source;
    assert.match(banner, /withheld/);
  });
});

describe("撤权立刻生效", () => {
  it("**每次还原都重新校验权限** —— 令牌 30 分钟有效，权限可能中途被撤", () => {
    const src = code(files.find((f) => f.path === "lib/rbac/preview.ts")!.source);
    const resolve = src.slice(src.indexOf("function resolvePreview"), src.indexOf("function endPreview"));
    assert.match(resolve, /effectivePermissions\(viewer\)/);
    assert.match(resolve, /PREVIEW_PERMISSION/);
  });

  it("被预览的人被封了，预览立刻断掉", () => {
    const src = code(files.find((f) => f.path === "lib/rbac/preview.ts")!.source);
    const resolve = src.slice(src.indexOf("function resolvePreview"), src.indexOf("function endPreview"));
    assert.match(resolve, /subject\.status === "banned"/);
  });
});

describe("**声明了就要真的被调用**", () => {
  /*
   * 这个项目里反复出现的同一个毛病：写了一个函数，接进了类型系统，
   * 看起来一切就绪 —— 但没有任何地方调它。
   * 这一轮我在自己刚写的代码里又犯了一次：revokePreviewsOf 写完之后
   * 一个调用点都没有，也就是说「掐断预览」这个能力压根不存在。
   */
  it("掐断预览接进了封禁那条路", () => {
    const actions = code(files.find((f) => f.path === "lib/admin/user-actions.ts")!.source);
    assert.match(actions, /revokePreviewsOf\(/, "封了号但他开着的预览还活着 —— 封禁看起来生效了，其实没有");
  });

  it("「踢下线」也包括预览", () => {
    const actions = code(files.find((f) => f.path === "lib/admin/user-actions.ts")!.source);
    const fn = actions.slice(actions.indexOf("revokeAllSessions(input.userId, \"admin\""));
    assert.match(fn.slice(0, 300), /revokePreviewsOf\(/);
  });

  it("预览模块导出的每个函数都有人用", () => {
    const src = files.find((f) => f.path === "lib/rbac/preview.ts")!.source;
    const exported = [...src.matchAll(/export function (\w+)/g)].map((m) => m[1]);
    assert.ok(exported.length >= 4, "导出的函数太少，这条检查可能没扫到东西");

    for (const name of exported) {
      const callers = files.filter(
        (f) => f.path !== "lib/rbac/preview.ts" && new RegExp(`\\b${name}\\(`).test(code(f.source)),
      );
      assert.ok(callers.length > 0, `${name} 声明了但没有任何地方调用 —— 它是个摆设`);
    }
  });
});

describe("这个权限给谁", () => {
  it("**只有站长** —— 其余 dangerLevel 3 的都在拒绝表里，这条没理由例外", () => {
    /*
     * 权限上它伤不到管理员自己（只减不增）。
     * 但隐私上会：切成一个普通成员后看到的是他的群列表、他的通知 ——
     * 而「群列表属于隐私」是这个站的明规矩。
     */
    const roles = files.find((f) => f.path === "lib/rbac/roles.ts")!.source;
    const denies = roles.slice(roles.indexOf("ADMIN_DENIES"), roles.indexOf("const ADMIN ="));
    assert.match(denies, /"system\.impersonate"/);
  });
});

/* ───────────────────────────────────────────────────────────────
 * 预览态也会**读**出不该读的东西
 *
 * 上面那些查的都是「预览时会不会写」。但预览是「以他的视角看看」——
 * 页面本来就照着被预览的人渲染，于是有些**只该本人看到**的东西
 * 会顺着这条路被摊开，而且一行代码都不用改就发生了。
 * ─────────────────────────────────────────────────────────────── */

describe("预览态下不该被看到的东西", () => {
  it("**「我的」页面上的微信 ID 只给本人看**", () => {
    /*
     * 拿着微信 ID 就能在微信里直接把人加上。
     * 这个站在别处为了不泄露它专门绕了一条 /members/by/<账号 id> 的中转
     * （成员目录连算头像颜色都不肯把 wx_id 放进 RSC 载荷），
     * 而「我的」这一页当时直接把它印在了页面上 ——
     * 页面取用户走的是 getCurrentUser()，预览态下那是**被预览的人**。
     *
     * 判据必须是 isSelf（realUser === user），不能只判「登录了没有」：
     * 预览态下也是登录着的。
     */
    const page = code(
      readFileSync(new URL("../src/app/(app)/me/page.tsx", import.meta.url), "utf8"),
    );

    assert.match(page, /const isSelf = realUser\?\.id === user\.id;/, "isSelf 的算法变了");

    const row = page.slice(page.indexOf("微信 ID") - 400, page.indexOf("微信 ID"));
    assert.match(row, /isSelf &&/, "微信 ID 那一行没有按 isSelf 收口 —— 预览时会露出别人的微信号");
  });
});
