import "server-only";

import { and, eq, isNull } from "drizzle-orm";

import { db } from "@/lib/db";
import { credentials, userRoles, users } from "@/lib/db/schema";
import { effectivePermissions } from "@/lib/rbac/can";
import { getSettingBool } from "@/lib/settings/store";
import { resolveDisplayName } from "@/lib/users/display-name";

import { isPrivileged, lockoutRisk, type LockoutRisk } from "./passkey-policy";

/**
 * 「开了强制 Passkey，谁会进不来」。
 *
 * 一个安全开关最危险的时刻不是它没生效，
 * 而是它**生效了但没人知道会有什么后果**。
 *
 * 所以这个数字要一直看得见：设置页上有，健康检查里也有。
 * 等某个管理员某天登不进来再去查，那时候他已经在门外了。
 */

/**
 * 扫一遍**所有拿过身份组的人**，不是只扫管理员。
 *
 * 只扫管理员的话，判据就退回成了按角色名判 ——
 * 而这里要问的恰恰是「谁手上有危险级权限」，
 * 那可能包括某个被单独授了权限的普通成员。
 */
export function passkeyLockoutRisk(): LockoutRisk {
  const holderIds = new Set(
    db
      .select({ userId: userRoles.userId })
      .from(userRoles)
      .where(isNull(userRoles.revokedAt))
      .all()
      .map((r) => r.userId),
  );

  const people = [...holderIds].flatMap((id) => {
    const user = db.select().from(users).where(eq(users.id, id)).get();
    if (!user) return [];
    // 已经封禁的人本来就登不进来，算进「会被锁在外面」只会让数字失真
    if (user.status !== "active") return [];

    const holds = (type: "passkey" | "password") =>
      db
        .select()
        .from(credentials)
        .where(
          and(
            eq(credentials.userId, id),
            eq(credentials.type, type),
            isNull(credentials.revokedAt),
          ),
        )
        .all().length > 0;

    return [
      {
        name: resolveDisplayName([user.siteNickname, user.wxNickname], { wxId: user.wxId }),
        privileged: isPrivileged(effectivePermissions(user).keys()),
        hasPasskey: holds("passkey"),
        hasPassword: holds("password"),
      },
    ];
  });

  return lockoutRisk(people, getSettingBool("auth.require_passkey_for_admin", true));
}
