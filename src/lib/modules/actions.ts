"use server";

import { revalidatePath } from "next/cache";

import { changeSetting } from "@/lib/admin/setting-actions";
import { requireAdmin } from "@/lib/admin/guard";
import { dependentsOf, moduleByKey } from "@/lib/modules/registry";

export interface ModuleActionResult {
  ok: boolean;
  error?: string;
  note?: string;
  /** 关掉它会连累谁 —— 确认之前要说出来 */
  affects?: string[];
}

/**
 * 开关一个模块。
 *
 * 关掉之前把**会被连累的模块**列出来。
 * 关掉「消息同步」的人往往只想暂停拉取，不知道那会同时让排行榜、签到、
 * 搜索、资源库、雷达全部停在当前这一刻 —— 而这几个模块的开关
 * 看起来还是开着的。
 */
export async function setModuleEnabled(input: {
  key: string;
  enabled: boolean;
  reason: string;
}): Promise<ModuleActionResult> {
  await requireAdmin("module.toggle");

  const spec = moduleByKey(input.key);
  if (!spec) return { ok: false, error: "没有这个模块" };
  if (spec.lockedOn) {
    return { ok: false, error: spec.lockReason ?? "这个模块不能关闭" };
  }
  if (!input.reason.trim()) {
    // 半年后翻审计日志的人需要知道当初为什么关的
    return { ok: false, error: "关停模块要写一句理由" };
  }

  /*
   * 走 changeSetting 而不是直接写 settings 表：
   * 变更历史、回滚、审计日志那一整套已经在那里了。
   * 自己再写一遍的结果一定是漏掉其中一样，而漏掉的那样
   * 恰好是事后想查的时候唯一需要的。
   */
  const result = await changeSetting({
    key: spec.settingKey,
    value: input.enabled ? "true" : "false",
    reason: input.reason,
  });
  if (!result.ok) return { ok: false, error: result.error };

  const affects = input.enabled ? [] : dependentsOf(input.key).map((m) => m.name);
  revalidatePath("/admin/modules");

  return {
    ok: true,
    affects,
    note: input.enabled
      ? `${spec.name} 已开启`
      : affects.length > 0
        ? `${spec.name} 已关闭 —— ${affects.join("、")}会跟着停摆`
        : `${spec.name} 已关闭：${spec.whenOff}`,
  };
}
