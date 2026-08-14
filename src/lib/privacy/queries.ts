import "server-only";

import { eq } from "drizzle-orm";

import type { CurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { userPrivacy, users } from "@/lib/db/schema";
import {
  PRIVACY_SWITCHES,
  withDefaults,
  type PrivacyKey,
  type PrivacySettings,
} from "@/lib/privacy/rules";
import { can } from "@/lib/rbac/can";

/**
 * 管理员不受**其中一个**开关的限制。
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
 * 这个人对**这一条**开关有没有豁免。
 *
 * ═════════════════════════════════════════
 * 有权限**不等于**能绕过任何一个开关
 * ═════════════════════════════════════════
 *
 * 原来这里只有 `bypassesPrivacy` 一个判断，四个调用点各自调它 ——
 * 于是一个权限一次性打开了所有开关。榜单和作息那两条从来没人
 * 决定过要不要给豁免，它们只是**顺带**被打开的。
 *
 * 站长把自己从榜上藏了，换个有管理权限的账号一看还在，
 * 就是这么来的。而榜单那条开关对他说的是「别人看到的榜单里没有你」。
 *
 * 所以豁免改成一条一条给，答案写在开关自己的登记表里
 * （`PRIVACY_SWITCHES[].adminBypass`），这里只负责取。
 * 这样「哪些开关有豁免」和「用户在界面上读到的那句话」
 * 挨在一起 —— 改一个不改另一个会当场被测试拦下。
 */
export function exemptFrom(viewer: CurrentUser | null, key: PrivacyKey): boolean {
  const spec = PRIVACY_SWITCHES.find((s) => s.key === key)!;
  // 先看这条开关准不准豁免，再花力气去解析权限
  return spec.adminBypass && bypassesPrivacy(viewer);
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
      hideActivityHours: userPrivacy.hideActivityHours,
    })
    .from(userPrivacy)
    .where(eq(userPrivacy.userId, userId))
    .get();

  /*
   * 「隐身」存在 `users.directory_hidden` 上，不在这张表里。
   *
   * 不为了整齐把它搬过来：`users.directory_hidden` 是真正接了线的
   * 那一个（成员目录、搜人都读它），搬家意味着改所有读它的地方，
   * 而每改一处都是一次「隐私开关可能失效」的机会。
   *
   * 界面上是一份清单，库里是两张表 —— 由这里合上。
   */
  const hidden = db
    .select({ directoryHidden: users.directoryHidden })
    .from(users)
    .where(eq(users.id, userId))
    .get();

  return withDefaults({ ...row, directoryHidden: hidden?.directoryHidden });
}

/**
 * 不想上榜的那些人的 wx_id。
 *
 * `exceptWxId` 是当前这个人自己 —— **自己永远能看到自己**。
 * 这和成员目录那个开关是同一条规矩：隐身之后自己那一行还在，
 * 标着「仅自己可见」。否则用户没有任何办法确认开关生效了，
 * 只能靠相信，而只能靠相信的隐私开关跟没有是一样的。
 */
/**
 * 榜单要用的那一整套判定，**一次算完**。
 *
 * ─────────────────────────────────────────
 * 为什么不是「排除名单」加一次权限判断
 * ─────────────────────────────────────────
 *
 * 榜单需要两件事：「该排除谁」和「这个人能不能看到访客看不到的东西」。
 * 分开问的话，权限解析要跑两遍（角色、权限、例外），
 * 一次榜单查询因此多花三条 SQL。
 *
 * ⚠️ `privileged` 现在**只管一件事**：给管理员标出
 * 「这一行访客看到的是『群成员』」（`anonymousToGuests`）。
 * 它**不再**影响 `hidden` —— 那条曾经让管理员看到完整的榜，
 * 而榜单开关对用户承诺的是「别人看到的榜单里没有你」。
 * 详见 `leaderboardHiddenWxIds` 上那段。
 *
 * 「谁藏了自己」这个答案现在**谁都拿不到**，包括管理员：
 * 它一旦被显示出来，藏起来的人反而比不藏更显眼。
 */
export interface LeaderboardPrivacy {
  /** 该从榜上排除的 wx_id —— 对所有视角都一样，除了自己看得到自己 */
  hidden: string[];
  /** 这个人看不看得到「访客眼里这一行是谁」这类审计信息 */
  privileged: boolean;
}

export function leaderboardPrivacy(viewer: CurrentUser | null): LeaderboardPrivacy {
  return {
    hidden: leaderboardHiddenWxIds(viewer),
    privileged: bypassesPrivacy(viewer),
  };
}

export function leaderboardHiddenWxIds(viewer: CurrentUser | null): string[] {
  /*
   * **管理员也看不到。**
   *
   * 这里原来有一条 `if (bypassesPrivacy(viewer)) return []`，
   * 理由写的是「不然管理员会以为公开的榜就长这样」——
   * 而那句话是反的：公开的榜**就是**长这样。
   *
   * 榜单那条开关对用户说的是「关掉之后别人看到的榜单里没有你」，
   * 一句没有例外的话。豁免的标准是「不给的话处理不了举报」，
   * 而没有任何一件审核工作需要知道一个藏起来的人排第几。
   *
   * 所以这个函数**不问视角有没有权限**，只排除自己 ——
   * 自己那一行要留着，否则没人能确认开关生效了。
   */
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
  if (exemptFrom(viewer, "searchableByOthers")) return [];

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


export interface HiddenWxIds {
  /** 关掉了「出现在榜单上」的人 */
  leaderboard: string[];
  /** 关掉了「别人能搜到我的发言」的人 */
  unsearchable: string[];
  /** 关掉了「在主页上显示我一般什么时候说话」的人 */
  activityHours: string[];
}

/**
 * 两份名单一次取完。
 *
 * ─────────────────────────────────────────
 * 分开取的代价不是一条 SQL，是三条
 * ─────────────────────────────────────────
 *
 * `leaderboardHiddenWxIds` 和 `unsearchableWxIds` 各自都要先问一次
 * 「这个人有没有豁免权」，而那次 `can()` 判定本身就要跑两条查询 ——
 * 于是同时要两份名单的页面（成员目录就是）白白多跑三条。
 *
 * 三条查询不会让任何东西出错，只会让「这一页要跑多少条」这个数字
 * 慢慢往上爬。N+1 守卫盯的正是这个数字，而它盯得对：
 * 这类重复一次加三条，加着加着就没有人记得每一条是为什么了。
 *
 * **两个开关的语义一个字都没变** —— 只是少问了两遍同一个问题。
 */
export function hiddenWxIds(viewer: CurrentUser | null): HiddenWxIds {
  /*
   * ⚠️ **豁免是逐条的，不是一刀切。**
   *
   * 这里原来是一句 `if (bypassesPrivacy(viewer)) return {三个都空}` ——
   * 一个权限同时打开了榜单、检索、作息三条，而只有检索那条
   * 想清楚过、也写给用户看过。
   *
   * 作息那条尤其不能跟着走：它暴露的是**一个人什么时候醒着**，
   * 而没有一条举报是靠这个处理的。
   */
  const searchExempt = exemptFrom(viewer, "searchableByOthers");

  const rows = db
    .select({
      wxId: users.wxId,
      hideFromLeaderboard: userPrivacy.hideFromLeaderboard,
      searchableByOthers: userPrivacy.searchableByOthers,
      hideActivityHours: userPrivacy.hideActivityHours,
    })
    .from(userPrivacy)
    .innerJoin(users, eq(users.id, userPrivacy.userId))
    .all();

  const leaderboard: string[] = [];
  const unsearchable: string[] = [];
  const activityHours: string[] = [];
  for (const row of rows) {
    // 自己永远看得见自己 —— 和两个单独取的函数同一条口径
    if (!row.wxId || row.wxId === viewer?.wxId) continue;
    if (row.hideFromLeaderboard) leaderboard.push(row.wxId);
    if (!row.searchableByOthers && !searchExempt) unsearchable.push(row.wxId);
    if (row.hideActivityHours) activityHours.push(row.wxId);
  }
  return { leaderboard, unsearchable, activityHours };
}
