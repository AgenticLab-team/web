import { domainModule } from "@/lib/activities/modules/domain";
import type { ActivityModule } from "@/lib/activities/types";

/**
 * 活动模块注册表。
 *
 * 与复核队列同一个道理：**只有代码里登记过的模块能被使用**。
 * 允许活动指向任意 moduleKey 的话，一条脏数据就能让页面去调
 * 一个不存在的东西，而那是在用户点开活动页时才炸的。
 *
 * 加一个新活动类型 = 在这里加一行 + 写一个实现了三个方法的模块。
 * 核心不需要动。
 */

const MODULES: ActivityModule<never>[] = [domainModule as ActivityModule<never>];

const byKey = new Map(MODULES.map((m) => [m.key, m]));

export function getModule(key: string): ActivityModule<never> | undefined {
  return byKey.get(key);
}

export function listModules(): ActivityModule<never>[] {
  return [...MODULES];
}

export function isKnownModule(key: string): boolean {
  return byKey.has(key);
}
