import "server-only";

import { db } from "@/lib/db";
import { shopItems } from "@/lib/db/schema";

/**
 * 初始商品。
 *
 * **默认全部下架**（enabled: false）—— 定价需要先看着通胀数据调，
 * 而一个定错价的商品会立刻被买空或者永远没人买，两种都不好收拾。
 * 在 /admin/shop 里确认价格之后再上架。
 *
 * 选品的原则是**优先可持续的回收口**：
 * 一次性商品买完回收就归零，按期续费的东西才让回收和时间同步发生。
 */

export interface ShopSeed {
  key: string;
  kind: "title" | "makeup_card" | "highlight" | "physical" | "custom";
  name: string;
  description: string;
  icon: string;
  price: number;
  stock: number | null;
  perUserLimit: number | null;
  config: Record<string, unknown>;
  sort: number;
}

export const BUILTIN_ITEMS: ShopSeed[] = [
  {
    key: "makeup_card",
    kind: "makeup_card",
    name: "补签卡",
    description: "断签的那天可以补回来，连胜不会因为一次忘记就归零。",
    icon: "🎫",
    price: 200,
    stock: null,
    // 一个月能补一次就够了 —— 再多的话连胜就不再意味着连续
    perUserLimit: null,
    config: { count: 1 },
    sort: 100,
  },
  {
    key: "custom_title",
    kind: "title",
    name: "自定义称号（月租）",
    description: "自己起一个名字挂在昵称后面，按月续费。",
    icon: "🏷️",
    price: 300,
    stock: null,
    perUserLimit: 1,
    config: { titleKey: "custom_monthly" },
    sort: 90,
  },
  {
    key: "highlight_post",
    kind: "highlight",
    name: "帖子置顶一天",
    description: "把自己的一篇帖子在版块里置顶 24 小时。",
    icon: "📌",
    price: 500,
    stock: null,
    perUserLimit: null,
    config: { hours: 24 },
    sort: 80,
  },
];

export function seedShopItems(): number {
  let created = 0;
  db.transaction((tx) => {
    for (const spec of BUILTIN_ITEMS) {
      const result = tx
        .insert(shopItems)
        .values({
          key: spec.key,
          kind: spec.kind,
          name: spec.name,
          description: spec.description,
          icon: spec.icon,
          price: spec.price,
          stock: spec.stock,
          perUserLimit: spec.perUserLimit,
          config: spec.config,
          // 默认下架 —— 定价确认之前不该有人能买
          enabled: false,
          sort: spec.sort,
        })
        .onConflictDoNothing()
        .run();
      if (result.changes > 0) created++;
    }
  });
  return created;
}
