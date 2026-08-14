import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { PERMISSION_LIST, RETIRED_PERMISSIONS } from "@/lib/rbac/permissions";

/**
 * 每个权限点到底管不管用。
 *
 * ─────────────────────────────────────────
 * 70 个里有 18 个从来没被判定过
 * ─────────────────────────────────────────
 *
 * 后台的权限矩阵把 70 个勾一视同仁地摆出来，看起来每一个都管事 ——
 * 而其中 18 个从来没有被传进任何一次判定。给一个人勾上它，
 * 什么都不会发生；把它取消掉，那个人照样做得了那件事。
 *
 * **权限是拿来限制人的东西，一个不生效的限制会让人以为已经限制住了。**
 *
 * 这一条测试的作用不是让那 18 个立刻消失（有些功能确实还没做），
 * 而是**逼它们如实标着** —— 标了 `wired` 就必须真的在某处被判过。
 */

const root = new URL("..", import.meta.url).pathname;

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
 * 一个权限点「被判定过」的所有形态。
 *
 * 直接写字面量只是其中一种 —— 还有挂在导航项上、
 * 存成常量再传进去、以及版块级的默认权限。
 * 只认第一种的话，这条测试会把一堆真的在用的权限点报成死的，
 * 然后所有人开始无视它。
 */
const PATTERNS = [
  /(?:can|requireAdmin|requireWritableAdmin|has|hasPermission|requirePermission)\(\s*(?:[a-zA-Z_$][\w$.]*\s*,\s*)?"([a-z0-9_.]+)"/g,
  /*
   * 「任一即可」的写法：`requireAdmin(["a", "b"])`。
   *
   * 一页上有两种人要看的东西时会用到它。只认单个字面量的话，
   * 数组里那几个会被报成「从来没被判过」—— 而它们正被判着。
   */
  /(?:requireAdmin|requireWritableAdmin)\(\s*\[([^\]]*)\]/g,
  /** 导航项上的「这个权限点也够进这一页」 */
  /alsoAllows:\s*\[([^\]]*)\]/g,
  /(?:PERMISSION|Permission)\s*[:=]\s*"([a-z0-9_.]+)"/g,
  /permission:\s*"([a-z0-9_.]+)"/g,
  /\?\?\s*"([a-z0-9_.]+)"\)\s*as\s*"/g,
];

function enforcedKeys(): Set<string> {
  const found = new Set<string>();
  for (const file of walk(join(root, "src"))) {
    if (file.endsWith("rbac/permissions.ts")) continue;
    const body = readFileSync(file, "utf8");
    for (const re of PATTERNS) {
      for (const m of body.matchAll(re)) {
        // 数组那两条捕获的是整段内容，里面可能有好几个 key
        for (const lit of m[1].matchAll(/[a-z0-9_.]+/g)) {
          if (lit[0].includes(".")) found.add(lit[0]);
        }
      }
    }
  }
  return found;
}

const enforced = enforcedKeys();

describe("**标着 wired 的必须真的被判过**", () => {
  for (const perm of PERMISSION_LIST) {
    if (perm.status === "planned") continue;
    it(`${perm.key}`, () => {
      assert.equal(
        enforced.has(perm.key),
        true,
        `「${perm.label}」在代码里从来没被判过 —— ` +
          `要么接上，要么标成 status: "planned"。` +
          `留着不标的话，后台勾上它什么都不会发生，而没有人看得出来`,
      );
    });
  }
});

describe("**标着 planned 的要么真没接，要么就该改回 wired**", () => {
  it("没有一个 planned 其实已经接上了", () => {
    /*
     * 反向也要盯：一个功能做完之后，很容易忘了把标记改回来。
     * 而一个明明生效、却标着「还没做」的权限点，
     * 会让人以为可以随便勾。
     */
    const stale = PERMISSION_LIST.filter((p) => p.status === "planned" && enforced.has(p.key)).map(
      (p) => p.key,
    );
    assert.deepEqual(stale, [], `这些已经接上了，标记该改成 wired：${stale.join(", ")}`);
  });
});

describe("**planned 里只该剩「功能真没做」的**", () => {
  /*
   * ─────────────────────────────────────────
   * 两种 planned，处理方式完全相反
   * ─────────────────────────────────────────
   *
   *   · 功能还没做 —— 等着就行
   *   · 功能做了，但代码用的是另一个更粗的权限点在管 ——
   *     这种更值得警惕：它意味着**细粒度授权做不到**
   *
   * 第二类一共有过 8 个。逐个查完之后：
   *
   *   接上 2 个（group.stats.read、group.sync.trigger）——
   *     它们是真的分权：看群统计 ≠ 改群配置，触发同步 ≠ 改群配置
   *   退役 6 个 —— 每一个都已经有更具体的机制在管同一件事，
   *     多留一个勾就是多一套判断，而多套一旦分叉，最松的那套就是漏的口
   *
   * 所以现在这张表该只剩第一类。写死在这里：新增一个 planned
   * 要动这一行，也就要有人过一眼它属于哪一类。
   */
  it("清单就是这 7 个，全是功能没做", () => {
    const planned = PERMISSION_LIST.filter((p) => p.status === "planned").map((p) => p.key);
    assert.deepEqual(
      [...planned].sort(),
      /*
       * `badge.manage` 从这里下来了 —— **退役**，不是接上。
       *
       * 「徽章」这个概念这个站明确决定不做：称号那边写着
       * 「数量刻意少。称号一多就变成徽章墙，每一个都不值钱了」。
       * 它想管的事已经有主 —— 授予荣誉走 user.title.grant，
       * 自动解锁走成就条件，上架出售走商店。
       *
       * 它属于第三类：**功能被否掉了**，既不是「没做」也不是
       * 「被更粗的权限管着」。留着等于承诺一件已经决定不做的事。
       */
      /*
       * `user.delete` 从这里下来了 —— **接上了**，不是退役。
       * 自助注销在「登录与安全」页，后台删号走 admin/user-actions。
       */
      /*
       * `mail.content.read` 是新加的，属于第一类（功能没做）——
       * 它管的是「看别人邮件的主题与正文」，而**那条通道本身还没建**：
       * P0 的后台只给元数据（地址、主人、到期、收了多少封、发件人），
       * 正文和主题一行代码都读不到。
       *
       * 它不属于第二类（被更粗的权限管着）—— 没有任何别的权限点
       * 今天能读到正文，包括站长的 mail.box.write。
       *
       * 它先注册着而不是等做的时候再加，是因为**这条线要先划出来**：
       * 邮箱里有验证码和找回密码链接，一个能静默读正文的后台
       * 等于一把能登录所有人第三方账号的万能钥匙。等到要做时才想起来
       * 分级，多半会顺手挂在已有的 mail.box.write 上。
       */
      [
        "broadcast.email",
        "mail.content.read",
        "module.config",
        "module.install",
        "permission.override",
        "user.export",
        "user.merge",
      ],
      "planned 清单变了 —— 新增的话先想清楚它是「功能没做」还是「被更粗的权限管着」",
    );
  });

  it("**没有一个 planned 是「被更粗的权限管着」** —— 那一类要么接上要么退役", () => {
    /*
     * 那一类的描述里会写「今天由 X 一起管」。留着这种描述
     * 等于承认细粒度授权在那儿做不到，而承认之后什么也不会发生。
     */
    const vague = PERMISSION_LIST.filter(
      (p) => p.status === "planned" && /今天由|一起管|只判登录|在管/.test(p.description ?? ""),
    ).map((p) => p.key);
    assert.deepEqual(vague, [], `这些是「被更粗的权限管着」，不是「功能没做」：${vague.join(", ")}`);
  });
});

describe("planned 的要说清楚为什么", () => {
  for (const perm of PERMISSION_LIST.filter((p) => p.status === "planned")) {
    it(`${perm.key} 有说明或者显然是功能没做`, () => {
      /*
       * 两种 planned 的处理不一样，所以要分得开：
       *   · 功能还没做 —— 等着就行
       *   · 功能做了，但代码用的是另一个更粗的权限点在管 ——
       *     这种更值得警惕：它意味着**细粒度的授权做不到**
       */
      const notImplemented = [
        "user.merge",
        "user.export",
        "permission.override",
        "module.install",
        "module.config",
        "broadcast.email",
        "badge.manage",
      ];
      if (notImplemented.includes(perm.key)) return;
      assert.ok(
        (perm.description ?? "").length > 4,
        `${perm.key} 标了 planned 但没说今天由谁在管`,
      );
    });
  }
});

describe("**管理员打得开他有权限的每一页**", () => {
  /*
   * 这一条是上面那个病最贵的一次表现：
   *
   * `ADMIN` 角色被显式拒绝了 `system.settings`，而功能开关那一页
   * 要的正是 `system.settings` —— 于是**管理员根本打不开它**，
   * 而专门为这件事存在的 `system.flags` 他有、却没有一行代码读。
   *
   * 存储页是反过来的：它只要 `system.dashboard`（进后台的最低门槛），
   * 而 `system.storage` 闲着 —— 也就是任何进得了后台的人都看得到。
   */
  const page = (p: string) => readFileSync(join(root, "src/app/(app)/admin", p), "utf8");

  it("功能开关页要的是 system.flags", () => {
    assert.match(page("flags/page.tsx"), /requireAdmin\("system\.flags"\)/);
  });

  it("存储页要的是 system.storage，不是「能进后台」", () => {
    assert.match(page("storage/page.tsx"), /requireAdmin\("system\.storage"\)/);
  });

  it("两页的写操作也走各自的权限点", () => {
    const flags = readFileSync(join(root, "src/lib/flags/actions.ts"), "utf8");
    const storage = readFileSync(join(root, "src/lib/storage/actions.ts"), "utf8");
    assert.match(flags, /requireWritableAdmin\("system\.flags"\)/);
    assert.match(storage, /requireWritableAdmin\("system\.storage"\)/);
  });
});

describe("**退役要退干净**", () => {
  /*
   * 从清单里删掉不够 —— 权限矩阵那一页读的是库里的 `permissions` 表。
   * 只删清单的话，那个勾照样摆在矩阵上，而且再没有人知道它是死的。
   *
   * 该退役的**不是「功能还没做」**（那种标 planned 就够了），
   * 是**已经有别的机制在管同一件事**的：多留一个勾，
   * 就是给了第三套判断的入口，而三套迟早分叉。
   */
  const keys = new Set(PERMISSION_LIST.map((p) => p.key));

  it("**退役名单本身不会悄悄少一条**", () => {
    /*
     * 这一条是被两次真实事故催出来的。
     *
     * 一次是往这张表里加条目时，一段正则把新加的 4 条连着删掉了 ——
     * **全量测试一个都没红**，是手动数了一遍才发现的。
     * 另一次在设置那边：插新条目时覆盖掉了旁边一条的 key，
     * 两条被并成一条，同样全绿，靠 tsc 的「同名属性」报错才抓到。
     *
     * 少一条的后果是安静的：seed 不再清理那个权限点，
     * 于是一个早就不该存在的勾又回到角色编辑页上，
     * 而它不对应任何一个具体动作 —— 授出去之后没有人说得清多了什么能力。
     *
     * 所以和 planned 一样钉死：改这张表要动这一行。
     */
    assert.deepEqual(
      RETIRED_PERMISSIONS.map((r) => r.key).sort(),
      [
        "activity.apply",
        "activity.view",
        "badge.manage",
        "digest.manage",
        "forum.react",
        "forum.view",
        "moderation.action",
      ],
      "退役名单变了 —— 少一条的话，那个勾会重新出现在角色编辑页上",
    );
  });

  it("**每条退役都写得出为什么**", () => {
    for (const r of RETIRED_PERMISSIONS) {
      assert.ok(r.why && r.why.length > 20, `${r.key} 的退役理由太短，等于没写`);
    }
  });

  it("退役的不能还留在清单里", () => {
    for (const r of RETIRED_PERMISSIONS) {
      assert.equal(keys.has(r.key as never), false, `${r.key} 同时在两张表里`);
    }
  });

  it("**退役的不能还有地方在判它**", () => {
    for (const r of RETIRED_PERMISSIONS) {
      assert.equal(enforced.has(r.key), false, `${r.key} 已退役，却还有地方在判`);
    }
  });

  it("**内建角色里也不能再授它**", () => {
    /*
     * 授一个不存在的权限点，在类型上会被 tsc 拦下 ——
     * 但自定义角色是运行时数据，拦不住。所以 seed 要负责清库，
     * 这一条盯着内建的那几个。
     */
    const roles = readFileSync(join(root, "src/lib/rbac/roles.ts"), "utf8");
    for (const r of RETIRED_PERMISSIONS) {
      assert.equal(roles.includes(`"${r.key}"`), false, `内建角色里还在授 ${r.key}`);
    }
  });

  it("**seed 会把它从两张表里都删掉**", () => {
    /*
     * `role_permissions` 里的授权行也要删：留着的话，
     * 「谁拥有 X」的反查会列出一批人，而 X 已经不存在了。
     */
    const seed = readFileSync(join(root, "src/lib/db/seed.ts"), "utf8");
    assert.match(seed, /RETIRED_PERMISSIONS/);
    assert.match(seed, /delete\(rolePermissions\)\.where\(eq\(rolePermissions\.permissionKey/);
    assert.match(seed, /delete\(permissionsTable\)\.where\(eq\(permissionsTable\.key/);
  });

  it("每个退役项都写清楚了「谁在管同一件事」", () => {
    // 说不出替代者的话，这条退役就没法复核 —— 它可能只是被忘了
    for (const r of RETIRED_PERMISSIONS) {
      assert.ok(r.why.length > 20, `${r.key} 没说清楚`);
    }
  });
});

describe("**任一即可的写法要被认出来**", () => {
  it("requireAdmin([...]) 里的权限点算被判过", () => {
    /*
     * 一页上有两种人要看的东西时会用到它。只认单个字面量的话，
     * 数组里那几个会被报成「从来没被判过」—— 而它们正被判着，
     * 于是所有人开始无视这条测试。
     */
    assert.equal(enforced.has("group.stats.read"), true);
  });

  it("导航项的 alsoAllows 也算", () => {
    const nav = readFileSync(join(root, "src/lib/admin/nav.ts"), "utf8");
    assert.match(nav, /alsoAllows: \["group\.stats\.read"\]/);
  });
});

describe("**群页：两个权限点各管各的**", () => {
  const page = readFileSync(join(root, "src/app/(app)/admin/groups/page.tsx"), "utf8");

  it("两个权限点任一即可进", () => {
    /*
     * 只认 group.manage 的话，group.stats.read 永远没有用武之地 ——
     * 授出去了也进不来这一页，于是那个勾等于不存在。
     */
    assert.match(page, /requireAdmin\(\["group\.manage", "group\.stats\.read"\]\)/);
  });

  it("**改群配置要 group.manage**", () => {
    assert.match(page, /canManage && <GroupConfig/);
  });

  it("**手动触发要 group.sync.trigger**", () => {
    assert.match(page, /canTrigger \? <SyncControls/);
    assert.match(page, /canTrigger && <SyncControls/);
  });

  it("**只读时说清楚是权限不够，不是页面坏了**", () => {
    // 一个按钮都没有的页面，不说明白的话看起来就是后者
    assert.match(page, /!canManage &&/);
    assert.match(page, /只读/);
  });

  it("群管理没有跟着丢掉触发同步的能力", () => {
    // 从 group.manage 里拆出来的时候最容易漏这一步
    const roles = readFileSync(join(root, "src/lib/rbac/roles.ts"), "utf8");
    const block = roles.slice(roles.indexOf("const GROUP_ADMIN"), roles.indexOf("const AUDITOR"));
    assert.match(block, /"group\.sync\.trigger"/);
  });
});

describe("**角色里的权限点重复会让站起不来**", async () => {
  /*
   * `role_permissions` 上有 (role_id, permission_key) 唯一约束，
   * 而几个角色是靠 `...MEMBER` 展开再补几条写出来的 ——
   * 补进一条 MEMBER 里已经有的，seed 直接抛异常。
   *
   * **seed 是开机跑的**：一条重复会让整个站起不来，
   * 而报错只说「UNIQUE constraint failed」，看不出是哪个角色。
   *
   * 这不是假想 —— 给群管理补 group.stats.read 的时候真的撞了一次，
   * 表现是十几个毫不相干的测试一起超时。
   */
  const { BUILTIN_ROLES, resolveRolePermissions } = await import("@/lib/rbac/roles");

  for (const role of BUILTIN_ROLES) {
    it(`${role.key} 解出来没有重复`, () => {
      const keys = resolveRolePermissions(role);
      assert.equal(new Set(keys).size, keys.length, `${role.key} 里有重复的权限点`);
    });
  }

  it("**授予和拒绝不能是同一个 key**", () => {
    // 同一行插两次也会撞唯一约束，而且语义上自相矛盾
    for (const role of BUILTIN_ROLES) {
      const granted = new Set(resolveRolePermissions(role));
      for (const denied of role.denies ?? []) {
        assert.equal(granted.has(denied), false, `${role.key} 既授予又拒绝了 ${denied}`);
      }
    }
  });
});
