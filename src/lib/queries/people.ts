import "server-only";

import { inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { people } from "@/lib/db/schema";
import { resolveDisplayName } from "@/lib/users/display-name";

/**
 * 一批 wx_id 的**当前**显示名。
 *
 * @提及 落库时存的是解析时刻的字面昵称，展示必须换成当前昵称 ——
 * 这是「昵称随时会变」这件事在读路径上的另一半：
 * 写时定人（wx_id），读时定名（这里）。
 *
 * 名字统一过 resolveDisplayName：people 表的存量数据里
 * 混进过 wx_id 当显示名，直接透出去就是隐私泄露。
 */
export function currentNamesFor(wxIds: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (wxIds.length === 0) return out;

  const rows = db
    .select({ wxId: people.wxId, displayName: people.displayName })
    .from(people)
    .where(inArray(people.wxId, wxIds))
    .all();

  for (const row of rows) {
    out.set(row.wxId, resolveDisplayName([row.displayName], { wxId: row.wxId }));
  }
  return out;
}
