import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { DEFAULT_SETTINGS, RETIRED_SETTINGS } from "@/lib/settings/defaults";

/**
 * 每个配置项到底管不管用。
 *
 * ─────────────────────────────────────────
 * 75 个里有 10 个从来没被读过
 * ─────────────────────────────────────────
 *
 * 后台设置页把 75 个旋钮一视同仁地摆出来，看起来每一个都管事 ——
 * 而其中 10 个从来没有被任何一行代码读过。管理员拨过去，
 * 什么都不会发生；拨回来，还是什么都不会发生。
 *
 * **一个拨了没反应的旋钮比没有旋钮坏得多**：它不是少了个功能，
 * 是给了一个错误的答案。而且管理员拨完不会再去验证 ——
 * 界面已经告诉他生效了。
 *
 * 这一条已经真的坑过一次：「论坛允许未登录浏览」关掉之后，
 * 论坛照样对所有人敞着。
 *
 * ─────────────────────────────────────────
 * 三条出路，没有第四条
 * ─────────────────────────────────────────
 *
 *   ① **接上** —— 真的有地方读它
 *   ② **标 `status: "planned"`** —— 功能还没做，后台会说明
 *   ③ **退役** —— 进 `RETIRED_SETTINGS`，seed 会把它从库里删掉
 *
 * 留着不标是唯一不允许的：那正是今天这 10 个的状态。
 */

const root = new URL("..", import.meta.url).pathname;
const DEFAULTS_FILE = join(root, "src/lib/settings/defaults.ts");

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
 * 「读过」= 真的有一次取值，不是「提到过这个字符串」。
 *
 * 说明文字、路由表上标注归哪个开关管、迁移脚本里的名字，
 * 都是**说明**，不是判定。把说明也算成读的话，这条测试会逼着人
 * 删说明，而说明正是下一个人需要的东西。
 *
 * ─────────────────────────────────────────
 * 三种间接读法都得认
 * ─────────────────────────────────────────
 *
 * 只认 `getSetting*("字面量")` 的话，下面这三种真读会被报成死的 ——
 * 而报假警的测试很快就没人看了，那比没有测试更糟：
 *
 *   **① 调用里带三元** —— `getSettingInt(x ? "a" : "b", …)`
 *   **② 键存成常量** —— `getSettingJson(LEVELS_SETTING_KEY, …)`
 *   **③ 键存在注册表里** —— `settingKey: "module.x.enabled"`，
 *      再由 `getSettingBool(spec.settingKey, …)` 统一读
 *
 * 每一条都要求**有消费的证据**：③ 只在确实存在
 * `getSetting*(….settingKey` 时才算数，否则一张没人读的注册表
 * 会把它表里所有的键都洗白。
 */
function readKeys(): Set<string> {
  const found = new Set<string>();
  const constKey = new Map<string, string>();
  const constUsed = new Set<string>();
  const registryKeys: string[] = [];
  let registryConsumed = false;

  for (const file of walk(join(root, "src"))) {
    if (file === DEFAULTS_FILE) continue;
    const body = readFileSync(file, "utf8");

    // ① 调用里出现的所有字面量（覆盖三元、多参）
    for (const call of body.matchAll(/getSetting\w*(?:<[^>]*>)?\(([^;]*?)\)/g)) {
      for (const lit of call[1].matchAll(/"([\w.]+)"/g)) found.add(lit[1]);
      for (const id of call[1].matchAll(/\b([A-Z][A-Z0-9_]{3,})\b/g)) constUsed.add(id[1]);
    }

    // ② 常量定义
    for (const m of body.matchAll(/\b([A-Z][A-Z0-9_]{3,})\s*=\s*"([\w.]+)"/g)) {
      constKey.set(m[1], m[2]);
    }

    // ③ 注册表字段，以及有没有人真的去读它
    for (const m of body.matchAll(/settingKey:\s*"([\w.]+)"/g)) registryKeys.push(m[1]);
    if (/getSetting\w*\([^;)]*\.settingKey/.test(body)) registryConsumed = true;
  }

  for (const name of constUsed) {
    const key = constKey.get(name);
    if (key) found.add(key);
  }
  if (registryConsumed) for (const k of registryKeys) found.add(k);

  return found;
}

const read = readKeys();

describe("**每个配置项要么被读，要么标了 planned，要么退役**", () => {
  for (const def of DEFAULT_SETTINGS) {
    if (def.status === "planned") continue;
    it(def.key, () => {
      assert.equal(
        read.has(def.key),
        true,
        `「${def.label}」摆在后台，而没有任何一行代码读它 —— ` +
          `管理员拨它不会有任何反应。接上，或者标 status: "planned"，` +
          `或者放进 RETIRED_SETTINGS`,
      );
    });
  }
});

describe("**标着 planned 的要么真没接，要么就该改回来**", () => {
  it("没有一个 planned 其实已经接上了", () => {
    /*
     * 反向也要盯：功能做完之后很容易忘了把标记去掉。
     * 一个明明生效、却标着「还没做」的旋钮，会让管理员不敢拨。
     */
    const stale = DEFAULT_SETTINGS.filter((d) => d.status === "planned" && read.has(d.key));
    assert.deepEqual(stale.map((d) => d.key), [], "这些已经接上了，把 planned 去掉");
  });

  it("planned 的数量没有偷偷长大", () => {
    /*
     * 一个不设上限的「以后再说」清单，就是把问题改名而已。
     * 数字写死在这里：新增一个 planned 要动这一行，也就要有人过一眼。
     */
    const planned = DEFAULT_SETTINGS.filter((d) => d.status === "planned").map((d) => d.key);
    assert.deepEqual(
      planned.sort(),
      ["forum.collapse_threshold", "storage.media_cache_max_bytes", "storage.thumb_max_edge"],
      "planned 清单变了 —— 如果是新增，先想想能不能直接接上",
    );
  });
});

describe("**退役要退干净**", () => {
  it("退役的键不能还留在默认清单里", () => {
    // 两张表都有的话，seed 先删后插，结果是它又回来了
    const keys = new Set(DEFAULT_SETTINGS.map((d) => d.key));
    for (const r of RETIRED_SETTINGS) {
      assert.equal(keys.has(r.key), false, `${r.key} 同时在两张表里`);
    }
  });

  it("**退役的键不能还有人读**", () => {
    // 读得到才怪 —— seed 会把行删掉，读到的永远是兜底值
    for (const r of RETIRED_SETTINGS) {
      assert.equal(read.has(r.key), false, `${r.key} 已退役，却还有地方在读`);
    }
  });

  it("**seed 真的会去删库里那一行**", () => {
    /*
     * 只从清单里删不够 —— 后台设置页列的是库里的行。
     * 漏掉这一步的话，那个旋钮照样摆在后台，
     * 而且从此再没有人知道它是死的。
     */
    const seed = readFileSync(join(root, "src/lib/db/seed.ts"), "utf8");
    assert.match(seed, /RETIRED_SETTINGS/);
    assert.match(seed, /delete\(settings\)\.where\(eq\(settings\.key, retired\.key\)\)/);
  });

  it("每个退役项都写了为什么", () => {
    // 「这个配置项去哪了」一定会有人问，答案得在代码里
    for (const r of RETIRED_SETTINGS) {
      assert.ok(r.why.length > 10, `${r.key} 没说为什么退役`);
    }
  });
});

describe("扫描本身没坏", () => {
  it("确实扫到了大部分键 —— 否则这条测试是在空转", () => {
    const hit = DEFAULT_SETTINGS.filter((d) => read.has(d.key)).length;
    assert.ok(hit > 50, `只认出 ${hit} 个被读的键，扫描八成坏了`);
  });
});
