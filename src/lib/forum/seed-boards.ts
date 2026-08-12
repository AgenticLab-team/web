import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { boards } from "@/lib/db/schema";

import { DEFAULT_BOARDS } from "./board-seeds";

/**
 * 把默认版块建出来。清单本身在 board-seeds.ts —— 那是事实，这里是动作。
 *
 * 只建缺的，已有的一律不碰：站长改过的名字、描述、排序都是他的决定，
 * 每次部署给他改回去是这类「自动修复」最讨厌的形状。
 */
export function seedBoards(): number {
  let created = 0;
  for (const seed of DEFAULT_BOARDS) {
    const existing = db.select().from(boards).where(eq(boards.key, seed.key)).get();
    if (existing) continue;
    db.insert(boards)
      .values({
        key: seed.key,
        name: seed.name,
        description: seed.description,
        icon: seed.icon,
        sort: seed.sort,
        visibleTo: seed.visibleTo,
        defaultVisibility: seed.defaultVisibility,
        maxVisibility: seed.maxVisibility,
        postMinLevel: seed.postMinLevel ?? 1,
        viewMode: seed.viewMode ?? "flat",
        createdBy: "system",
      })
      .run();
    created++;
  }
  return created;
}
