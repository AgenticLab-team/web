import "server-only";

import { and, count, eq } from "drizzle-orm";

import { isPrivileged } from "@/lib/auth/passkey-policy";
import { hasPasskey } from "@/lib/auth/passkey";
import { hasPassword } from "@/lib/auth/password-login";
import type { CurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { loginAttempts, users } from "@/lib/db/schema";
import { effectivePermissions } from "@/lib/rbac/can";

import {
  CODE_LOGIN_METHOD,
  nudgeCopy,
  nudgeDecision,
  type NudgeCopy,
  type NudgeDecision,
} from "./passkey-nudge-rules";

/**
 * 「加个 Passkey 吧」这条提醒的取值与落库。
 *
 * 判定本身一行都不在这里 —— 全在 passkey-nudge-rules.ts。
 * 这一层只做两件事：把散在四张表里的事实凑齐，以及**在这里读一次时钟**。
 * 后者是硬要求：render 期间读 `Date.now()` 过不了 React Compiler 那关，
 * 而「上次推掉是多久以前」正是一个非读时钟不可的判断。
 */

/**
 * 这个人用验证码成功登录过几次。
 *
 * 只数 success 的。失败的那些不算 —— 一个连着输错五次的人
 * 受的罪更多，但那是另一个问题（限流），把它算进来会让提醒
 * 提前到一个和「重复取验证码」无关的时刻。
 */
export function codeLoginCount(userId: string): number {
  return (
    db
      .select({ n: count() })
      .from(loginAttempts)
      .where(
        and(
          eq(loginAttempts.userId, userId),
          eq(loginAttempts.method, CODE_LOGIN_METHOD),
          eq(loginAttempts.success, true),
        ),
      )
      .get()?.n ?? 0
  );
}

export interface PasskeyNudge extends NudgeCopy {
  /** 用来在测试和排查里回答「为什么没弹」，页面不显示它 */
  decision: NudgeDecision;
}

/**
 * 现在要不要给这个人摆提醒；要的话说什么。
 *
 * 传整个 user 而不是 userId，是因为 privileged 的判定要走
 * `effectivePermissions(user)` —— 权限是现算的，不能拿一个
 * 缓存下来的布尔糊弄，否则刚被授权的人会在提醒这一侧
 * 被当成普通成员对待。
 *
 * **调用方必须传真人**（getRealUser 的结果），不能传 getCurrentUser 的。
 * 后者在预览态下是被预览的那个人，于是管理员「以他的视角看看」时
 * 会看到别人的提醒，而那两个按钮会写到别人的账号上。
 */
export function passkeyNudgeFor(user: CurrentUser, now = Date.now()): PasskeyNudge | null {
  const decision = nudgeDecision({
    hasPasskey: hasPasskey(user.id),
    privileged: isPrivileged(effectivePermissions(user).keys()),
    declinedAt: user.passkeyNudgeDeclinedAt,
    snoozedAt: user.passkeyNudgeSnoozedAt,
    codeLoginCount: codeLoginCount(user.id),
    now,
  });

  if (!decision.show) return null;

  return { ...nudgeCopy({ hasPassword: hasPassword(user.id) }), decision };
}

/**
 * 「以后再说」——记下推掉的时刻。
 *
 * 每次都覆盖成最新的时间，而不是只记第一次：数的是
 * 「上次推掉到现在多久了」，留着最早那一次的话，
 * 一个连着推了三回的人会在第二回之后就被立刻再提一遍。
 */
export function snoozePasskeyNudge(userId: string, now = Date.now()): void {
  db.update(users)
    .set({ passkeyNudgeSnoozedAt: now, updatedAt: now })
    .where(eq(users.id, userId))
    .run();
}

/**
 * 「不用了」——永远不再提。
 *
 * 顺手把 snoozedAt 清掉。留着它没有害处，但两列同时有值
 * 会让下一个读这张表的人以为「不用了」是有期限的，
 * 而它没有。
 */
export function declinePasskeyNudge(userId: string, now = Date.now()): void {
  db.update(users)
    .set({ passkeyNudgeDeclinedAt: now, passkeyNudgeSnoozedAt: null, updatedAt: now })
    .where(eq(users.id, userId))
    .run();
}

/**
 * 撤销「不用了」。
 *
 * 这个站的规矩是「不弹确认框，直接执行并给撤销机会」（见 PasskeySetup 顶上那段）。
 * 而「不用了」是**永久**的：手机上三个按钮挨着排，按歪一下
 * 就再也收不到这条提醒了。没有撤销的话，那次误触没有任何补救办法。
 *
 * 撤销之后两列都清空 —— 回到「从来没表过态」，而不是回到「推迟中」：
 * 一个刚刚按错、马上点了撤销的人，想要的是那张卡片回来。
 */
export function undoDeclinePasskeyNudge(userId: string, now = Date.now()): void {
  db.update(users)
    .set({ passkeyNudgeDeclinedAt: null, passkeyNudgeSnoozedAt: null, updatedAt: now })
    .where(eq(users.id, userId))
    .run();
}
