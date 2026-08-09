import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { now, ulidPk } from "./_shared";

/**
 * 传上去的文件。
 *
 * ─────────────────────────────────────────
 * 文件不在我们这儿，这张表仍然要有
 * ─────────────────────────────────────────
 *
 * 图床是 files.mrusercontent.com，字节不落在这台机器上。
 * 那为什么还要记一行？两个理由，都不是「以防万一」：
 *
 * ① **有人传了不该传的东西时，得知道是谁传的。** 那条链接会出现在
 *    帖子里、被转发出去，而链接本身不带任何身份信息。
 *    没有这张表的话，唯一的线索是「谁的帖子里有它」——
 *    而转帖的人和上传的人往往不是同一个。
 *
 * ② **限流要有依据。** 上游的访客通道是 10 分钟 20 次（按 IP），
 *    而我们是从服务器代传的，全站共用一个出口 IP。
 *    我们自己这一侧得先按人限住，否则一个人就能把全站的额度用光。
 *
 * 不记文件内容、不记哈希：我们没有那份字节，
 * 记一个自己算不出来的东西只会给人一种「查得到」的错觉。
 */
export const uploads = sqliteTable(
  "uploads",
  {
    id: ulidPk(),
    userId: text("user_id").notNull(),

    /** 上游给的直链。**存 url 而不是存 id** —— 我们要靠它反查「这张图是谁传的」 */
    url: text("url").notNull(),
    kind: text("kind", { enum: ["image", "video"] }).notNull(),
    mime: text("mime").notNull(),
    bytes: integer("bytes").notNull(),
    /** 原始文件名，只用于展示和排查。**不参与任何路径拼接** */
    filename: text("filename"),

    /*
     * 上传那一刻的 IP。
     *
     * 和审计日志一个道理：出事时它是唯一能把一次上传和一个人
     * 之外的东西联系起来的线索（比如同一个 IP 短时间内换了三个账号）。
     * 注意站点在 Cloudflare 后面，这里存的必须是真实客户端 IP，
     * 而不是边缘节点 —— 见 nginx 的 real_ip 配置。
     */
    ip: text("ip"),

    createdAt: now("created_at"),
  },
  (t) => [
    // 限流要问「这个人最近传了几次」
    index("uploads_user_idx").on(t.userId, t.createdAt),
    // 审核要问「这条链接是谁传的」
    index("uploads_url_idx").on(t.url),
  ],
);
