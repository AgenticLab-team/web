import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { boards } from "@/lib/db/schema";
import type { Visibility } from "@/lib/db/schema/forum";

/**
 * 默认版块。
 *
 * 每个版块的 maxVisibility 都是**封顶**，不是默认值 ——
 * 「群聊沉淀」版封顶就是 group，从结构上杜绝群聊内容被公开，
 * 而不是靠每次发帖时记得选对。
 */
interface BoardSeed {
  key: string;
  name: string;
  description: string;
  icon: string;
  sort: number;
  visibleTo: Visibility;
  defaultVisibility: Visibility;
  maxVisibility: Visibility;
  postMinLevel?: number;
  viewMode?: "flat" | "threaded";
}

export const DEFAULT_BOARDS: BoardSeed[] = [
  {
    key: "general",
    name: "综合讨论",
    description: "什么都能聊。未登录也能看",
    icon: "messages-square",
    sort: 10,
    visibleTo: "public",
    defaultVisibility: "public",
    maxVisibility: "public",
  },
  {
    key: "qa",
    name: "问答",
    description: "有问题就问，可以悬赏积分",
    icon: "help-circle",
    sort: 20,
    visibleTo: "public",
    defaultVisibility: "public",
    maxVisibility: "public",
  },
  {
    key: "showcase",
    name: "项目展示",
    description: "把你在做的东西亮出来",
    icon: "sparkles",
    sort: 30,
    visibleTo: "public",
    defaultVisibility: "public",
    maxVisibility: "public",
  },
  {
    key: "inside",
    name: "内部事务",
    description: "社群运营与内部讨论，登录成员可见",
    icon: "lock",
    sort: 40,
    visibleTo: "member",
    defaultVisibility: "member",
    maxVisibility: "member",
  },
  {
    key: "archive",
    name: "群聊沉淀",
    description: "从群聊转存的讨论。只有原群成员看得到",
    icon: "archive",
    sort: 50,
    visibleTo: "member",
    defaultVisibility: "group",
    // 封顶就是 group：从结构上杜绝这个版块的内容被公开
    maxVisibility: "group",
  },
];

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
