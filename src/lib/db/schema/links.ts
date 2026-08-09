import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { now, ulidPk } from "./_shared";

/**
 * 资源库里的一条链接。
 *
 * 一条链接只有一行，不管被分享过多少次 —— 谁在什么时候分享的
 * 记在 link_mentions 里。反过来（一次分享一行）的话，
 * 同一个东西会在列表里出现五次，而那正是资源库最没用的样子。
 */
export const links = sqliteTable(
  "links",
  {
    id: ulidPk(),
    /** 归一化后的去重键：抹掉 www.、协议、末尾斜杠、追踪参数 */
    urlKey: text("url_key").notNull(),
    /** 清理过、可以直接点的地址 */
    url: text("url").notNull(),
    domain: text("domain").notNull(),

    /** 展示用标题；取自路径或域名，不去抓网页 */
    title: text("title").notNull(),
    /** 说明，取自分享它的那条消息 —— 抓不到就留空，不编 */
    note: text("note"),

    /** 被分享过几次（冗余列，真值是 link_mentions 的行数） */
    shareCount: integer("share_count").notNull().default(1),
    firstSharedAt: integer("first_shared_at").notNull(),
    lastSharedAt: integer("last_shared_at").notNull(),

    /*
     * 大模型根据上下文整理出来的标题与简介。
     *
     * **和抓取来的 title/note 分开存**，两个原因：
     *   · 界面上要能说清楚哪一条是机器写的 —— 一个语气笃定的简介，
     *     人默认它是可靠的，得让他知道来源
     *   · 换了模型、发现某一批质量不行时，能整批清掉重来，
     *     而不会连原始的 title 一起丢
     */
    aiTitle: text("ai_title"),
    aiSummary: text("ai_summary"),
    /**
     * 问过模型的时间。
     *
     * 问过但模型说「看不出来」的条目，这里有值而 aiTitle 为空 ——
     * 靠这个区分「还没问过」和「问过了，确实说不清」，
     * 否则每次同步都会把同一批说不清的链接再问一遍。
     */
    aiCheckedAt: integer("ai_checked_at"),
    aiModel: text("ai_model"),

    /** 管理员隐藏：广告、失效、不宜出现在列表里的 */
    hidden: integer("hidden", { mode: "boolean" }).notNull().default(false),
    hiddenReason: text("hidden_reason"),

    createdAt: now("created_at"),
  },
  (t) => [
    uniqueIndex("links_key_idx").on(t.urlKey),
    index("links_domain_idx").on(t.domain, t.lastSharedAt),
    index("links_recent_idx").on(t.hidden, t.lastSharedAt),
  ],
);

/**
 * 一次分享。
 *
 * 群 id 记在这里，是**可见性的依据**：只有该群的成员看得到这条链接。
 * 页面上不显示是哪个群 —— 显示了就等于把群名泄露给了另一个群的人。
 */
export const linkMentions = sqliteTable(
  "link_mentions",
  {
    id: ulidPk(),
    linkId: text("link_id").notNull(),
    convId: text("conv_id").notNull(),
    /** 来源消息；手动提交的为空 */
    messageId: text("message_id"),
    sharerWxId: text("sharer_wx_id"),
    sharerName: text("sharer_name"),
    sharedAt: integer("shared_at").notNull(),
  },
  (t) => [
    // 同一条消息里的同一个链接只记一次 —— 重跑回填不该让计数翻倍
    uniqueIndex("link_mentions_msg_idx").on(t.linkId, t.messageId),
    index("link_mentions_link_idx").on(t.linkId, t.sharedAt),
    index("link_mentions_conv_idx").on(t.convId, t.sharedAt),
  ],
);

/** 我收藏的链接 */
export const linkSaves = sqliteTable(
  "link_saves",
  {
    id: ulidPk(),
    userId: text("user_id").notNull(),
    linkId: text("link_id").notNull(),
    createdAt: now("created_at"),
  },
  (t) => [uniqueIndex("link_saves_user_idx").on(t.userId, t.linkId)],
);
