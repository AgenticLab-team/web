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
    /*
     * 反馈与报错。
     *
     * 站长的原话：「就是引导用户遇到 bug 来到某一个板块发言」——
     * 明确不要工单系统。
     *
     * 版块比工单好的地方恰恰在于**公开**：
     * 别人报过的问题你看得见，于是不会再报一遍；
     * 而工单系统里每个人都在自己的隔间里，同一个 bug 会被报二十次，
     * 处理的人也没法一次回答所有人。
     *
     * 所以 visibleTo 是 public：没登录的人也能看到已知问题。
     * 但发帖仍然要登录 —— 一个公开可写的板块两天就会被灌满。
     */
    key: "feedback",
    name: "反馈与报错",
    description: "站点坏了、用着别扭、想要什么功能，都发这里。先翻一下有没有人报过",
    icon: "bug",
    sort: 35,
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
