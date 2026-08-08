import "server-only";

import { db } from "@/lib/db";
import { titles } from "@/lib/db/schema";

import { BUILTIN_TITLES } from "./builtin";

/**
 * 写入内置称号。
 *
 * **只补不改**：管理员改过名字、价格、名额之后，重启不能把它冲掉。
 */

export function seedTitles(): number {
  let created = 0;
  db.transaction((tx) => {
    for (const spec of BUILTIN_TITLES) {
      const result = tx
        .insert(titles)
        .values({
          key: spec.key,
          name: spec.name,
          description: spec.description,
          icon: spec.icon,
          rarity: spec.rarity,
          source: spec.source,
          price: spec.price ?? null,
          rentDays: spec.rentDays ?? null,
          conditionKind: spec.conditionKind ?? null,
          conditionValue: spec.conditionValue ?? null,
          limitCount: spec.limitCount ?? null,
          sort: spec.sort,
        })
        .onConflictDoNothing()
        .run();
      if (result.changes > 0) created++;
    }
  });
  return created;
}
