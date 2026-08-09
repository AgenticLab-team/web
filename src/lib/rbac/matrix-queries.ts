import "server-only";

import { db } from "@/lib/db";
import { roles } from "@/lib/db/schema";

/** roleId -> 身份组名字。diff 里要显示名字,而不是一串 id */
export function roleNameMap(): Map<string, string> {
  return new Map(db.select().from(roles).all().map((r) => [r.id, r.name]));
}
