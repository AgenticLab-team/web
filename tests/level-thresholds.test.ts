import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  MAX_LEVEL_NAME,
  checkLevels,
  previewShift,
  unlocksByLevel,
  type LevelDef,
} from "@/lib/points/level-rules";
import { LEVELS, levelOf, levelProgress } from "@/lib/points/rules";

/**
 * 等级门槛。
 *
 * ─────────────────────────────────────────
 * 两件事，一个是 bug 一个是缺口
 * ─────────────────────────────────────────
 *
 * **bug：等级只在打卡时更新。** `users.level` 全站只有一处会写 ——
 * checkin.ts 里手写的那一行。靠打赏、邀请奖励、人工调整攒到 50 分的人
 * **永远停在 L1**，而版块的 post_min_level 是按 level 判的，
 * 他会被挡在门外，页面上还写着「你当前 L1」，看起来像是分没算对。
 *
 * 生产上暂时没人踩到（分几乎全来自打卡，而打卡那条路碰巧对），
 * 但它只是还没发生，不是不会发生。
 *
 * **缺口：门槛写死在代码里。** 而「一切阈值走配置、后台可改、
 * 改动有历史」是这个站写在 defaults.ts 顶上的规则。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

const good: LevelDef[] = [
  { level: 1, requires: 0, name: "一" },
  { level: 2, requires: 50, name: "二" },
  { level: 3, requires: 150, name: "三" },
];

describe("**门槛表的校验**", () => {
  it("正常的过", () => {
    const r = checkLevels(good);
    assert.equal(r.ok, true);
  });

  it("**必须严格递增** —— 不递增会变成「攒得越多等级越低」", () => {
    /*
     * levelOf 是顺序扫描、遇到不满足就 break 的。门槛不递增时
     * 它会在中间停下，而这种行为没有人会想到去查。
     */
    const bad = [
      { level: 1, requires: 0, name: "一" },
      { level: 2, requires: 100, name: "二" },
      { level: 3, requires: 60, name: "三" },
    ];
    const r = checkLevels(bad);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /一级比一级高/);
    // 说清楚是哪一级 —— 一句「格式不对」对着十行数字的人没有帮助
    assert.match(r.error, /L3/);
  });

  it("持平也不行", () => {
    assert.equal(
      checkLevels([
        { level: 1, requires: 0, name: "一" },
        { level: 2, requires: 50, name: "二" },
        { level: 3, requires: 50, name: "三" },
      ]).ok,
      false,
    );
  });

  it("**L1 的门槛必须是 0** —— 否则刚注册的人算不出等级", () => {
    const r = checkLevels([
      { level: 1, requires: 10, name: "一" },
      { level: 2, requires: 50, name: "二" },
    ]);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /L1 的门槛必须是 0/);
  });

  it("等级号要从 1 开始连续 —— 跳号会让「下一级」算错", () => {
    assert.equal(
      checkLevels([
        { level: 1, requires: 0, name: "一" },
        { level: 3, requires: 50, name: "三" },
      ]).ok,
      false,
    );
  });

  it("名字必填、不能太长 —— 等级名会显示给所有人", () => {
    assert.equal(checkLevels([{ level: 1, requires: 0, name: "  " }, good[1]]).ok, false);
    assert.equal(
      checkLevels([{ level: 1, requires: 0, name: "长".repeat(MAX_LEVEL_NAME + 1) }, good[1]]).ok,
      false,
    );
  });

  it("至少两级 —— 只有一级等于没有等级", () => {
    assert.equal(checkLevels([{ level: 1, requires: 0, name: "一" }]).ok, false);
  });

  it("坏输入一律拒，不炸", () => {
    for (const bad of [null, "x", 42, [], [{}], [{ level: "a", requires: 0, name: "一" }]]) {
      assert.equal(checkLevels(bad).ok, false);
    }
  });

  it("代码里那份默认门槛自己要合法", () => {
    // 兜底值不合法的话，坏配置回退之后仍然是坏的
    assert.equal(checkLevels(LEVELS).ok, true);
  });
});

describe("**改门槛之前要看得到后果**", () => {
  it("提高门槛 = 给人降级", () => {
    /*
     * 把 L2 从 50 提到 500，是在给所有 L2 的人降级 ——
     * 而降级会连带把他们挡在按等级卡的版块外面。
     */
    const after: LevelDef[] = [
      { level: 1, requires: 0, name: "一" },
      { level: 2, requires: 500, name: "二" },
      { level: 3, requires: 900, name: "三" },
    ];
    const shift = previewShift([0, 60, 200], good, after);
    assert.equal(shift.demoted, 2);
    assert.equal(shift.promoted, 0);
    assert.equal(shift.unchanged, 1);
  });

  it("降低门槛 = 给人升级", () => {
    const after: LevelDef[] = [
      { level: 1, requires: 0, name: "一" },
      { level: 2, requires: 10, name: "二" },
      { level: 3, requires: 20, name: "三" },
    ];
    const shift = previewShift([0, 15, 30], good, after);
    assert.equal(shift.promoted, 2);
  });

  it("没改就全都不变", () => {
    const shift = previewShift([0, 60, 200], good, good);
    assert.equal(shift.promoted, 0);
    assert.equal(shift.demoted, 0);
    assert.equal(shift.unchanged, 3);
  });
});

describe("**「解锁了什么」是反查的，不是编的**", () => {
  it("从版块的 post_min_level 反查", () => {
    /*
     * 编一个「L5 解锁私信」的列表很容易，而那些东西没有任何代码在读 ——
     * 那是又一个死开关，只不过穿着说明文档的皮。
     */
    const unlocks = unlocksByLevel(
      [
        { name: "综合", postMinLevel: 1 },
        { name: "内部", postMinLevel: 3 },
      ],
      good,
    );
    assert.deepEqual(unlocks.find((u) => u.level === 1)?.boards, ["综合"]);
    assert.deepEqual(unlocks.find((u) => u.level === 3)?.boards, ["内部"]);
    assert.deepEqual(unlocks.find((u) => u.level === 2)?.boards, []);
  });
});

describe("levelOf 走传进来的表", () => {
  it("同一个分数，两份门槛给出不同等级", () => {
    const strict: LevelDef[] = [
      { level: 1, requires: 0, name: "一" },
      { level: 2, requires: 1000, name: "二" },
    ];
    assert.equal(levelOf(100, good).level, 2);
    assert.equal(levelOf(100, strict).level, 1);
  });

  it("不传就用代码里的默认值", () => {
    assert.equal(levelOf(0).level, 1);
    assert.equal(levelOf(50).level, 2);
  });

  it("levelProgress 也认这份表", () => {
    const p = levelProgress(60, good);
    assert.equal(p.current.level, 2);
    assert.equal(p.next?.level, 3);
    assert.equal(p.remaining, 90);
  });

  it("**顶级之后不再有下一级**", () => {
    const p = levelProgress(99999, good);
    assert.equal(p.next, null);
    assert.equal(p.ratio, 1);
  });
});

describe("**等级要在所有积分变动时重算，不只是打卡**", () => {
  it("grantPoints 里算等级 —— 那是所有积分变动的唯一入口", () => {
    /*
     * 原来只有 checkin.ts 那一行会更新 level。
     */
    const ledger = strip(src("lib/points/ledger.ts"));
    assert.match(ledger, /level: levelOf\(pointsTotal, configuredLevels\(\)\)\.level/);
  });

  it("**checkin 里那份删掉了** —— 两处算等级早晚对不上", () => {
    const checkin = strip(src("lib/points/checkin.ts"));
    // 更新语句里不该再出现 level
    const update = checkin.slice(checkin.indexOf("lastCheckinDate: today"));
    assert.doesNotMatch(update.slice(0, 400), /level:/);
  });

  it("每个 levelOf / levelProgress 的调用点都传了配置表", () => {
    /*
     * 门槛可配之后，忘了传的表现是**静默地用了默认门槛** ——
     * 没有报错，只是数字不对。
     */
    for (const f of [
      "lib/points/ledger.ts",
      "lib/points/checkin.ts",
      "app/(app)/me/points/page.tsx",
    ]) {
      const code = strip(src(f));
      /*
       * 不要用 `\(([^)]*)\)` 去截参数 —— 它在 `configuredLevels()`
       * 里面那个右括号就停住了，于是永远匹配不到。截一段往后看就够。
       */
      for (const m of code.matchAll(/level(?:Of|Progress)\(/g)) {
        const tail = code.slice(m.index!, m.index! + 90);
        assert.match(tail, /configuredLevels\(\)/, `${f} 有一处没传门槛表：${tail.slice(0, 50)}`);
      }
    }
  });

  it("规则层不碰数据库 —— 门槛表是传进去的，不是它自己去读的", () => {
    const rules = src("lib/points/rules.ts");
    for (const forbidden of ["server-only", "@/lib/db", "getSetting"]) {
      assert.equal(rules.includes(forbidden), false, `规则层引了 ${forbidden}`);
    }
    const levelRules = src("lib/points/level-rules.ts");
    for (const forbidden of ["server-only", "@/lib/db", "drizzle-orm"]) {
      assert.equal(levelRules.includes(forbidden), false, `规则层引了 ${forbidden}`);
    }
  });
});

describe("接线", () => {
  it("门槛存成配置，走现成的历史与回滚", () => {
    assert.match(src("lib/settings/defaults.ts"), /key: "points\.levels"/);
    assert.match(src("lib/settings/defaults.ts"), /type: "json"/);
    assert.match(strip(src("lib/points/level-actions.ts")), /updateSetting\(LEVELS_SETTING_KEY/);
  });

  it("**这是全站第一个 json 类型的设置** —— 校验器早就支持，一直没人用", () => {
    const validate = src("lib/settings/validate.ts");
    assert.match(validate, /case "json":/);
  });

  it("**保存之后所有人的等级立刻重算**", () => {
    /*
     * 不重算的话，一个人的等级会停在旧门槛下算出来的值，
     * 而按等级卡的版块立刻按新门槛判 ——
     * 于是「我明明是 L3」和「这里需要 L3」同时成立却进不去。
     */
    const actions = strip(src("lib/points/level-actions.ts"));
    assert.match(actions, /levelOf\(row\.pointsTotal, verdict\.levels\)\.level/);
    assert.match(actions, /db\.transaction/);
  });

  it("坏配置退回默认，不抛异常 —— 否则一份存坏的表会让每次积分变动都失败", () => {
    const levels = strip(src("lib/points/levels.ts"));
    assert.match(levels, /return LEVELS;/);
    // 而且后台要说出来，不能默默用默认的
    assert.match(levels, /export function levelsHealth/);
    assert.match(src("app/(app)/admin/points/levels/page.tsx"), /库里那份门槛表是坏的/);
  });

  it("L1 的门槛在界面上改不动", () => {
    assert.match(src("components/admin/LevelEditor.tsx"), /disabled=\{i === 0\}/);
  });

  it("降级会连带挡人，界面上说出来了", () => {
    assert.match(src("components/admin/LevelEditor.tsx"), /降级的人会被挡在按等级卡的版块外面/);
  });

  it("后台有入口", () => {
    assert.match(src("lib/admin/nav.ts"), /href: "\/admin\/points\/levels"/);
    assert.match(src("components/admin/AdminNav.tsx"), /"trending-up": TrendingUp/);
  });
});

describe("**「use server」文件只能导出 async 函数**", () => {
  it("level-actions 里没有同步导出", () => {
    /*
     * 一开始把 `levelCounts`（同步查询）放进了 level-actions.ts，
     * 而那个文件是 `"use server"` —— 构建直接失败：
     * 「Server Actions must be async functions」。
     *
     * 部署脚本因此没有重启服务，线上还是旧版本，没出事 ——
     * 但这条得钉住，因为编辑器和 tsc 都不会提前说。
     */
    const code = strip(src("lib/points/level-actions.ts"));
    assert.match(code, /^"use server";/);
    for (const m of code.matchAll(/^export (?:function|const) (\w+)/gm)) {
      assert.fail(`level-actions.ts 导出了同步的 ${m[1]}`);
    }
  });

  it("全站的 use server 文件都只导出 async", () => {
    const files = [
      "lib/points/level-actions.ts",
      "lib/points/admin-actions.ts",
      "lib/flags/actions.ts",
      "lib/forum/draft-actions.ts",
      "lib/forum/schedule-actions.ts",
      "lib/forum/follow-actions.ts",
      "lib/forum/bookmark-actions.ts",
      "lib/auth/identity-actions.ts",
    ];
    for (const f of files) {
      const code = strip(src(f));
      if (!/^"use server";/.test(code)) continue;
      for (const m of code.matchAll(/^export (?:function|const) (\w+)/gm)) {
        assert.fail(`${f} 导出了同步的 ${m[1]}`);
      }
    }
  });
});
