import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DANGEROUS_SETTING_KEYS,
  isDangerousSetting,
  needsBackfillWarning,
  validateSettingValue,
} from "@/lib/settings/validate";

/**
 * 配置值校验。
 *
 * 读取侧遇到非法值会退回代码默认值，听起来很稳，
 * 实际上制造了最难查的一类 bug：**后台显示的和实际生效的不是一回事**。
 * 把上限填成 "6O"（字母 O）会保存成功、页面显示 6O，
 * 而系统一直在用 60 —— 没有任何地方报错，
 * 直到几个月后有人问「我明明改过为什么没生效」。
 */

const intSpec = { key: "points.economy.daily_mint_cap", type: "int" as const, minValue: 0, maxValue: 10_000 };

describe("整数", () => {
  it("正常整数通过并归一化", () => {
    const r = validateSettingValue(intSpec, "60");
    assert.equal(r.ok, true);
    assert.equal(r.normalized, "60");
  });

  it("**字母 O 冒充零会被拒**", () => {
    // 这是真会发生的手滑，而且肉眼几乎看不出来
    const r = validateSettingValue(intSpec, "6O");
    assert.equal(r.ok, false);
    assert.match(r.error!, /整数/);
  });

  it("空值被拒 —— Number(\"\") 是 0，那不是用户的意思", () => {
    assert.equal(validateSettingValue(intSpec, "").ok, false);
    assert.equal(validateSettingValue(intSpec, "   ").ok, false);
  });

  it("小数被拒", () => {
    assert.equal(validateSettingValue(intSpec, "1.5").ok, false);
  });

  it("科学计数法被拒 —— 存进去以后没人看得懂", () => {
    assert.equal(validateSettingValue(intSpec, "1e3").ok, false);
  });

  it("前后空格会被去掉，不算非法", () => {
    assert.equal(validateSettingValue(intSpec, " 60 ").normalized, "60");
  });

  it("前导零会被归一化 —— 否则 060 和 60 会被记成一次「变更」", () => {
    assert.equal(validateSettingValue(intSpec, "060").normalized, "60");
  });

  it("**下限被强制执行**", () => {
    const r = validateSettingValue(intSpec, "-1");
    assert.equal(r.ok, false);
    assert.match(r.error!, /不能小于/);
  });

  it("**上限被强制执行**", () => {
    const r = validateSettingValue(intSpec, "99999");
    assert.equal(r.ok, false);
    assert.match(r.error!, /不能大于/);
  });

  it("边界值本身是允许的", () => {
    assert.equal(validateSettingValue(intSpec, "0").ok, true);
    assert.equal(validateSettingValue(intSpec, "10000").ok, true);
  });

  it("没设上下限时不误拦", () => {
    const spec = { key: "x", type: "int" as const, minValue: null, maxValue: null };
    assert.equal(validateSettingValue(spec, "-99999").ok, true);
  });

  it("超出安全整数范围被拒", () => {
    const spec = { key: "x", type: "int" as const };
    assert.equal(validateSettingValue(spec, "99999999999999999999").ok, false);
  });
});

describe("布尔", () => {
  const spec = { key: "x", type: "bool" as const };

  it("多种写法都认，并归一化成 true/false", () => {
    for (const v of ["true", "1", "yes", "ON"]) {
      assert.equal(validateSettingValue(spec, v).normalized, "true", `${v} 没被认作真`);
    }
    for (const v of ["false", "0", "no", "OFF"]) {
      assert.equal(validateSettingValue(spec, v).normalized, "false", `${v} 没被认作假`);
    }
  });

  it("**含糊的值被拒，而不是默默当成 false**", () => {
    // 当成 false 的话，开关会在管理员以为打开了的时候关着
    assert.equal(validateSettingValue(spec, "开").ok, false);
    assert.equal(validateSettingValue(spec, "").ok, false);
  });
});

describe("JSON", () => {
  const spec = { key: "x", type: "json" as const };

  it("合法 JSON 通过并归一化", () => {
    const r = validateSettingValue(spec, '{ "a" : 1 }');
    assert.equal(r.ok, true);
    assert.equal(r.normalized, '{"a":1}');
  });

  it("非法 JSON 被拒", () => {
    assert.equal(validateSettingValue(spec, "{a:1}").ok, false);
  });

  it("空值被拒", () => {
    assert.equal(validateSettingValue(spec, "").ok, false);
  });
});

describe("字符串", () => {
  const spec = { key: "x", type: "string" as const };

  it("允许空值 —— 有些配置留空是有意义的", () => {
    assert.equal(validateSettingValue(spec, "").ok, true);
  });

  it("首尾空白会被去掉", () => {
    assert.equal(validateSettingValue(spec, "  登录  ").normalized, "登录");
  });
});

describe("追溯提醒", () => {
  it("**判定规则类的配置要提醒不会追溯**", () => {
    // 改了但历史数据不重算，是最隐蔽的不一致：
    // 榜单和当前规则对不上，而没有任何地方会报错
    assert.equal(needsBackfillWarning("sync.quality_min"), true);
    assert.equal(needsBackfillWarning("points.checkin.base"), true);
  });

  it("与历史数据无关的配置不提醒 —— 否则提醒会变成噪音", () => {
    assert.equal(needsBackfillWarning("auth.bind_code.ttl_seconds"), false);
  });
});

describe("危险配置", () => {
  it("**改错会静默影响所有人的那几项被标为危险**", () => {
    assert.equal(isDangerousSetting("points.economy.daily_mint_cap"), true);
    assert.equal(isDangerousSetting("sync.quality_min"), true);
  });

  it("普通配置不算危险 —— 复核队列塞满琐事的话，重要的就被淹没了", () => {
    assert.equal(isDangerousSetting("points.checkin.base"), false);
  });

  it("危险清单不为空且都是具体的键", () => {
    assert.ok(DANGEROUS_SETTING_KEYS.length > 0);
    assert.ok(DANGEROUS_SETTING_KEYS.every((k) => k.includes(".")));
  });
});
