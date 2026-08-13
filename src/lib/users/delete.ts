import "server-only";

import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { DELETION_PLAN } from "@/lib/users/deletion-plan";

/**
 * 真的执行注销。
 *
 * ─────────────────────────────────────────
 * 一次事务，要么全做完要么一点没做
 * ─────────────────────────────────────────
 *
 * 中途失败最坏的形态不是「没删干净」，是**删了一半**：
 * 会话删了、账号还在 —— 人被登出，却还在榜单和成员目录里，
 * 而他已经没法登进来问为什么了。
 *
 * ─────────────────────────────────────────
 * 按登记表办事，不在这里写第二份名单
 * ─────────────────────────────────────────
 *
 * 要删哪些表由 `deletion-plan.ts` 说了算，这里只负责执行。
 * 在这个文件里再列一遍的话，两份迟早分叉 ——
 * 而分叉的方向是「登记表上写着删、实际没删」，
 * 那种漏没有任何地方看得出来。
 */

export interface DeleteResult {
  /** 每张表清掉了几行 */
  purged: Record<string, number>;
  /** 抹掉作者的帖子与回复数 */
  anonymized: { posts: number; replies: number };
  ok: boolean;
}

/** 注销之后昵称统一显示成这个 —— 只在兜底读不到名字时用得上 */
export const DELETED_LABEL = "已注销";

/**
 * `purge` 那一档里，主键列不叫 `user_id` 的几张。
 *
 * 不显式写出来的话只能猜列名，而猜错的表现是**这张表根本没被清**，
 * 且不报错 —— 注销跑完了，痕迹还在。
 */
/**
 * 哪些表不是按 `user_id` 找主人的。
 *
 * 导出是为了让测试用**同一份**：测试里原来抄了一份
 * （`plan.table === "keyword_hits" ? "sub_id" : "user_id"`），
 * 于是加第二张挂靠表时，代码改了而测试还按老映射跑 ——
 * 它报「列名对不上」，而实际上对得上，只是测试不知道。
 */
export const OWNER_COLUMN: Record<string, string> = {
  // 雷达命中挂在订阅下面，没有直接的 user_id
  keyword_hits: "sub_id",
  // 刷新令牌挂在授权关系下面，同理
  oauth_refresh_tokens: "grant_id",
};

export function deleteAccount(
  userId: string,
  options: { by: string; reason: string },
): DeleteResult {
  const purged: Record<string, number> = {};
  let anonymized = { posts: 0, replies: 0 };

  /*
   * ─────────────────────────────────────────
   * 挂靠的先删，被挂靠的后删
   * ─────────────────────────────────────────
   *
   * `keyword_hits` 要顺着 `keyword_subs` 才找得到主人。
   * 按登记表的顺序走的话，订阅先被删掉 —— 于是那句
   * `WHERE sub_id IN (SELECT id FROM keyword_subs WHERE user_id = ?)`
   * 查出来是空的，命中一条都删不掉，**成了永远清不掉的孤儿**。
   *
   * 而且它不报错：注销跑完了，日志上一切正常。
   * （第一版就是这么写的，注释里还写着「不依赖顺序」——
   *   注释是对的，代码没跟上。测试跑起来才发现。）
   */
  const purgePlans = DELETION_PLAN.filter((p) => p.disposition === "purge");
  const ordered = [...purgePlans.filter((p) => p.via), ...purgePlans.filter((p) => !p.via)];

  db.transaction((tx) => {
    const before = tx.select().from(users).where(eq(users.id, userId)).get();
    if (!before) throw new Error("账号不存在");

    for (const plan of ordered) {
      const column = OWNER_COLUMN[plan.table] ?? "user_id";

      const changes =
        plan.via
          ? tx.run(
              sql`DELETE FROM ${sql.identifier(plan.table)}
                  WHERE ${sql.identifier(column)} IN (
                    SELECT id FROM ${sql.identifier(plan.via.table)} WHERE user_id = ${userId}
                  )`,
            ).changes
          : tx.run(
              sql`DELETE FROM ${sql.identifier(plan.table)}
                  WHERE ${sql.identifier(column)} = ${userId}`,
            ).changes;

      if (changes > 0) purged[plan.table] = changes;
    }

    /*
     * 帖子与回复：作者置空，正文不动。
     *
     * 置成 NULL 而不是某个占位 id —— 占位 id 会被当成一个真实账号，
     * 于是「这个人发过的帖」里会冒出一堆不同的人的旧帖挤在一起。
     */
    anonymized = {
      posts: tx.run(
        sql`UPDATE forum_posts SET author_id = '' WHERE author_id = ${userId}`,
      ).changes,
      replies: tx.run(
        sql`UPDATE forum_replies SET author_id = '' WHERE author_id = ${userId}`,
      ).changes,
    };
    tx.run(sql`UPDATE forum_tips SET from_user_id = '' WHERE from_user_id = ${userId}`);

    /*
     * 账号本身：留壳、抹内容。
     *
     * **wx_id 必须清空** —— 帖子作者名是顺着 `users.wx_id → people`
     * 查出来的，留着的话旧帖子照样显示昵称、头像和主页链接，
     * 「抹掉作者」就完全没有发生。挡在读取侧行不通：
     * 论坛列表、收藏、积分后台、关注……漏一处就是一次泄露。
     *
     * 同时把它抄进 `prior_wx_id`：邀请那条「一个人只能被邀请一次」
     * 是按 user_id 判的，而注销重绑会拿到新的 user_id ——
     * 没有这份副本，注销就成了刷邀请奖励的通道。
     */
    tx.run(
      sql`UPDATE users SET
            status = 'deleted',
            prior_wx_id = wx_id,
            wx_id = NULL,
            site_nickname = NULL,
            wx_nickname = NULL,
            wx_avatar_url = NULL,
            username = NULL,
            email = NULL,
            phone = NULL,
            bio = NULL,
            meta = NULL,
            deleted_at = ${Date.now()},
            deleted_by = ${options.by},
            delete_reason = ${options.reason}
          WHERE id = ${userId}`,
    );
  });

  return { purged, anonymized, ok: true };
}
