import "server-only";

import { getSettingBool } from "@/lib/settings/store";
import { MODULES, moduleByKey, resolveStates, type ModuleState } from "@/lib/modules/registry";

/**
 * 模块开关的读取。
 *
 * 判定点全部走 `isModuleEnabled(key)`，不直接读 settings ——
 * 依赖被关掉时「开着但没在工作」这条规则只在 resolveStates 里，
 * 绕过它就会出现一个开关开着、依赖关着、代码却照跑的模块。
 */

export function enabledMap(): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const spec of MODULES) {
    map[spec.key] = spec.lockedOn ? true : getSettingBool(spec.settingKey, true);
  }
  return map;
}

export function moduleStates(): ModuleState[] {
  return resolveStates(enabledMap());
}

/**
 * 这个模块现在该不该干活。
 *
 * 依赖被关掉也返回 false —— 「开着但依赖没了」在功能上等于关着，
 * 让调用方还去跑一遍只会产生一堆没人看的数据。
 */
export function isModuleEnabled(key: string): boolean {
  if (moduleByKey(key)?.lockedOn) return true;
  const state = moduleStates().find((s) => s.key === key);
  return state?.status === "on";
}
