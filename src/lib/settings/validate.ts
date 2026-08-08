/**
 * 配置值校验。纯函数。
 *
 * ─────────────────────────────────────────
 * 为什么写入侧必须校验
 * ─────────────────────────────────────────
 *
 * 读取侧已经很小心了：`getSettingInt` 拿到非数字会退回代码里的默认值。
 * 听起来很稳，实际上制造了最难查的一类 bug ——
 * **后台显示的和实际生效的不是一回事**。
 *
 * 管理员把每日发放上限填成 "6O"（字母 O），保存成功、页面上显示 6O，
 * 而系统一直在用代码里的 60。没有任何地方报错，
 * 直到几个月后有人问「我明明改过为什么没生效」。
 *
 * 所以拒绝要发生在**保存的那一刻**，而不是靠读取侧兜底。
 */

export interface SettingSpec {
  key: string;
  type: "string" | "int" | "bool" | "json";
  minValue?: number | null;
  maxValue?: number | null;
  label?: string | null;
}

export interface ValidationResult {
  ok: boolean;
  error?: string;
  /** 归一化后的值。布尔统一成 "true"/"false"，数字去掉前导零 */
  normalized?: string;
}

const ok = (normalized: string): ValidationResult => ({ ok: true, normalized });
const no = (error: string): ValidationResult => ({ ok: false, error });

export function validateSettingValue(spec: SettingSpec, raw: string): ValidationResult {
  const value = raw.trim();

  switch (spec.type) {
    case "int": {
      if (value === "") return no("不能留空");
      // Number("") 是 0、Number(" 12 ") 是 12 —— 都不是想要的，所以先用正则卡住形态
      if (!/^-?\d+$/.test(value)) return no(`必须是整数（收到「${raw}」）`);

      const n = Number(value);
      if (!Number.isSafeInteger(n)) return no("数字太大了");

      if (spec.minValue !== null && spec.minValue !== undefined && n < spec.minValue) {
        return no(`不能小于 ${spec.minValue}`);
      }
      if (spec.maxValue !== null && spec.maxValue !== undefined && n > spec.maxValue) {
        return no(`不能大于 ${spec.maxValue}`);
      }
      return ok(String(n));
    }

    case "bool": {
      const lower = value.toLowerCase();
      if (["true", "1", "yes", "on"].includes(lower)) return ok("true");
      if (["false", "0", "no", "off"].includes(lower)) return ok("false");
      return no("必须是 true 或 false");
    }

    case "json": {
      if (value === "") return no("不能留空");
      try {
        // 存归一化后的 JSON —— 否则同一个值因为空格不同会被记成一次「变更」
        return ok(JSON.stringify(JSON.parse(value)));
      } catch {
        return no("不是合法的 JSON");
      }
    }

    case "string":
      // 字符串允许空值：有些配置（比如可选的前缀词）留空是有意义的
      return ok(value);
  }
}

/**
 * 改了这项之后要不要提醒「不会追溯已有数据」。
 *
 * 判定规则改了但历史数据不重算，是这套系统里最隐蔽的不一致：
 * 榜单上的数字和当前规则对不上，而没有任何地方会报错。
 */
const RETROACTIVE_KEYS = new Set(["sync.quality_min"]);

const RETROACTIVE_PREFIXES = ["points.", "sync."];

export function needsBackfillWarning(key: string): boolean {
  if (RETROACTIVE_KEYS.has(key)) return true;
  return RETROACTIVE_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * 危险配置：改错会**静默地**影响所有人，且不会有人立刻发现。
 *
 * 这类改动要走双人复核。判断标准不是「重要」，
 * 是「改错之后多久才会有人察觉」—— 越久越危险。
 */
const DANGEROUS_KEYS = new Set([
  // 设成 0 全站都拿不到积分，而大家只会以为「今天没发分」
  "points.economy.daily_mint_cap",
  // 改了之后历史判定与当前规则不一致，榜单会长期不对
  "sync.quality_min",
  // 调高会把所有人挡在门外，而被挡的人不会来报告，只会不再登录
  "auth.bind_code.daily_limit",
  "auth.bind_code.burst_limit",
]);

export function isDangerousSetting(key: string): boolean {
  return DANGEROUS_KEYS.has(key);
}

export const DANGEROUS_SETTING_KEYS = [...DANGEROUS_KEYS];
