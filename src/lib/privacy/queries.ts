import "server-only";

import { eq } from "drizzle-orm";

import type { CurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { userPrivacy, users } from "@/lib/db/schema";
import { withDefaults, type PrivacySettings } from "@/lib/privacy/rules";
import { can } from "@/lib/rbac/can";

/**
 * 管理员不受这两个开关的限制。
 *
 * ─────────────────────────────────────────
 * 为什么是「处理举报队列」这个权限
 * ─────────────────────────────────────────
 *
 * 有人举报一条发言，而发言的人关掉了「别人能搜到我的发言」——
 * 处理举报的人**找不到那条内容**，举报就处理不了。
 * 一个能被自己关掉的审核，等于没有审核。
 *
 * 用 `moderation.queue` 而不是「进得了后台」（`system.dashboard`）：
 * 后者宽得多，一个只看仪表盘数字的人没有理由绕过别人的隐私设置。
 *
 * ─────────────────────────────────────────
 * 豁免只能写在这一个地方
 * ─────────────────────────────────────────
 *
 * 四个调用点各写一遍权限判断的话，迟早有一处写错 ——
 * 而写错的方向如果是「漏判」，那就是把关掉开关的人重新暴露出去，
 * **并且没有任何人看得出来**。所以判断收在这里，
 * 调用方只管把 user 传进来。
 */
export const PRIVACY_BYPASS_PERMISSION = "moderation.queue" as const;

export function bypassesPrivacy(user: CurrentUser | null): boolean {
  return !!user && can(user, PRIVACY_BYPASS_PERMISSION).allowed;
}

/**
 * 隐私开关的读取。
 *
 * ─────────────────────────────────────────
 * 榜单和检索都是按 wx_id 认人的
 * ─────────────────────────────────────────
 *
 * `daily_stats` 和 `messages` 存的是微信那一侧的 `wx_id`，
 * 而开关挂在站内账号 `users.id` 上 —— 中间靠 `users.wx_id` 搭桥。
 *
 * 所以这里导出的是**一串 wx_id**，让调用方直接扔进 SQL 的
 * NOT IN 里去。这一点很要紧：**过滤必须落在 SQL 里**，
 * 不能查出来再在 JS 里 filter —— 后者会让分页和名次算错，
 * 一个第 3 名被过滤掉之后，第 4 名仍然显示「第 4 名」，
 * 而榜上只有 49 行。
 */

export function privacyOf(userId: string): PrivacySettings {
  const row = db
    .select({
      hideFromLeaderboard: userPrivacy.hideFromLeaderboard,
      searchableByOthers: userPrivacy.searchableByOthers,
    })
    .from(userPrivacy)
    .where(eq(userPrivacy.userId, userId))
    .get();
  return withDefaults(row);
}

/**
 * 不想上榜的那些人的 wx_id。
 *
 * `exceptWxId` 是当前这个人自己 —— **自己永远能看到自己**。
 * 这和成员目录那个开关是同一条规矩：隐身之后自己那一行还在，
 * 标着「仅自己可见」。否则用户没有任何办法确认开关生效了，
 * 只能靠相信，而只能靠相信的隐私开关跟没有是一样的。
 */
export function leaderboardHiddenWxIds(viewer: CurrentUser | null): string[] {
  /*
   * 管理员看到的是完整的榜。
   *
   * ⚠ 界面上**还没有**把「别人看不到的那几行」标出来 ——
   * 不标的话管理员会以为公开的榜就长这样，然后照着一个只有他
   * 自己看得到的名次去发公告、发奖。记在 ROADMAP.md 里了。
   */
  if (bypassesPrivacy(viewer)) return [];

  const rows = db
    .select({ wxId: users.wxId })
    .from(userPrivacy)
    .innerJoin(users, eq(users.id, userPrivacy.userId))
    .where(eq(userPrivacy.hideFromLeaderboard, true))
    .all();

  return rows
    .map((r) => r.wxId)
    .filter((wxId): wxId is string => wxId !== null && wxId !== viewer?.wxId);
}

/**
 * 不想被别人搜到的那些人的 wx_id。
 *
 * 同样排除掉自己：一个人关掉这个开关之后**还得能搜自己说过的话** ——
 * 那是他自己的东西，而「我上次在哪说过这事」正是搜索最常见的用法。
 */
export function unsearchableWxIds(viewer: CurrentUser | null): string[] {
  /*
   * 管理员搜得到所有人。
   *
   * 举报要处理、违规内容要查 —— 一个能被当事人自己关掉的审核，
   * 等于没有审核。这条豁免在开关的说明里也写明了，
   * 不能只写在代码里：让人以为管理员也搜不到，
   * 他会照着一个不存在的保护去说话。
   */
  if (bypassesPrivacy(viewer)) return [];

  const rows = db
    .select({ wxId: users.wxId })
    .from(userPrivacy)
    .innerJoin(users, eq(users.id, userPrivacy.userId))
    .where(eq(userPrivacy.searchableByOthers, false))
    .all();

  return rows
    .map((r) => r.wxId)
    .filter((wxId): wxId is string => wxId !== null && wxId !== viewer?.wxId);
}

