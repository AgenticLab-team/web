import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { now, ulidPk } from "./_shared";

/**
 * 自己填的技能标签。
 *
 * 只存**注册用户主动填的**。不从聊天记录里推断，也不从群成员表生成 ——
 * 一个人出现在群成员表里，不代表他同意自己出现在一个可以按技能检索的
 * 名录上。前者是微信群的事实，后者是这个站替他做的公开。
 */
export const userSkills = sqliteTable(
  "user_skills",
  {
    id: ulidPk(),
    userId: text("user_id").notNull(),

    /** 归一化后的匹配键：大小写、空格、全角都抹平 */
    slug: text("slug").notNull(),
    /** 用户写下来的样子，用来显示 */
    label: text("label").notNull(),

    sort: integer("sort").notNull().default(0),
    createdAt: now("created_at"),
  },
  (t) => [
    // 同一个人不能有两个同义标签 —— 否则筛选结果里他会出现两次
    uniqueIndex("user_skills_user_slug_idx").on(t.userId, t.slug),
    index("user_skills_slug_idx").on(t.slug),
  ],
);
