import "server-only";

import { inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { tips } from "@/lib/db/schema";

/** 一次查完整页的打赏总额，不逐条查 */
export function tipsOfTargets(targets: { type: "post" | "reply"; id: string }[]): Map<string, number> {
  const result = new Map<string, number>();
  if (targets.length === 0) return result;

  const rows = db
    .select({ targetId: tips.targetId, total: sql<number>`SUM(${tips.points})` })
    .from(tips)
    .where(inArray(tips.targetId, targets.map((t) => t.id)))
    .groupBy(tips.targetId)
    .all();

  for (const row of rows) result.set(row.targetId, Number(row.total));
  return result;
}
