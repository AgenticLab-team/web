import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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

/**
 * 每个人在每个群里「常挂在嘴边」的那个词 —— **算好存下来**。
 *
 * ═════════════════════════════════════════
 * 为什么必须预先算
 * ═════════════════════════════════════════
 *
 * 实测：一个说了四千多条消息的人，现算要 1.9 秒；而基准
 * （同群其他人的片段统计，四十万个片段）还要再 1.5 秒。
 * 放在打开主页的路径上，等于每看一次别人的主页就卡三秒。
 *
 * 算一轮全站只要几秒 —— 因为绝大多数人消息数不够门槛，
 * 在统计之前就返回了。所以这是一件典型的「批量算一次、读时白拿」。
 *
 * ═════════════════════════════════════════
 * 为什么按「人 × 群」存，不是按人存
 * ═════════════════════════════════════════
 *
 * 页面上一切统计都限定在**查看者和这个人的共同群**里
 * （见 `personProfileFor`）。按人存一份全站口径的话，
 * 一个只和你同在 A 群的人，会把他在 B 群的说话习惯透给你 ——
 * 而 B 群的存在本身就不该让你知道。
 *
 * 存成「人 × 群」，读的时候只挑共同群里的那几行，这条边界就自动成立。
 */
export const personPhrases = sqliteTable(
  "person_phrases",
  {
    wxId: text("wx_id").notNull(),
    convId: text("conv_id").notNull(),
    phrase: text("phrase").notNull(),
    /** 说了多少次 */
    hits: integer("hits").notNull(),
    /** 出现在多少条不同消息里 —— 挡复制粘贴 */
    msgs: integer("msgs").notNull(),
    /** 横跨多少天 —— 挡「那几天在聊这个」 */
    days: integer("days").notNull(),
    /** 是同群其他人的几倍 */
    lift: real("lift").notNull(),
    /** 排名分数，跨群挑最高的那个 */
    score: real("score").notNull(),
    /**
     * 他在这个群里点得最多的微信表情（`[旺柴]` 里的那个词）。
     *
     * 和口头禅分开存，因为它**不是他说的话** —— 混在一起的话，
     * 页面上会出现「他常把旺柴挂在嘴边、说过 52 次」这种错话
     * （线上第一版真出过，112 个人里有四个）。
     */
    emoji: text("emoji"),
    emojiHits: integer("emoji_hits"),
    computedAt: integer("computed_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.wxId, t.convId] })],
);
