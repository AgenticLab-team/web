"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { userPrivacy } from "@/lib/db/schema";
import { isPrivacyKey, storedValue, type PrivacyKey } from "@/lib/privacy/rules";

/**
 * 拨一个隐私开关。
 *
 * ─────────────────────────────────────────
 * 这里不记审计
 * ─────────────────────────────────────────
 *
 * 这个项目的规矩是「每一个后台写操作都要经过审计」，但这一条不是后台操作，
 * 而且**把「谁在什么时候把自己藏起来了」记成一张永久只增不删的表，
 * 恰好是这个功能要避免的事**。审计表 owner 都删不掉。
 *
 * 想藏起来的人会因此变成审计日志里一条永久记录 —— 那比不给开关更糟。
 */

export type PrivacyResult = { ok: true; note: string } | { ok: false; error: string };

export async function setPrivacySwitch(key: string, on: boolean): Promise<PrivacyResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "先登录" };

  // 开关名从客户端来，用自有键判断而不是 `in`（后者会走原型链）
  if (!isPrivacyKey(key)) return { ok: false, error: "没有这个开关" };

  const column: PrivacyKey = key;
  const value = storedValue(column, on);

  /*
   * upsert：绝大多数人没有这一行。
   *
   * 「先查再插」在这里是错的 —— 同一个人在两个设备上同时拨，
   * 两边都查到「没有这一行」，然后都插，撞主键。
   */
  db.insert(userPrivacy)
    .values({ userId: user.id, [column]: value, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: userPrivacy.userId,
      set: { [column]: value, updatedAt: Date.now() },
    })
    .run();

  /*
   * 榜单和检索页都是 force-dynamic / 现算的，但「我的」那一页
   * 会显示「藏起来了 N 样」，不刷的话用户拨完开关回去看还是旧数字，
   * 于是会以为没保存上。
   */
  revalidatePath("/me/privacy");
  revalidatePath("/me");

  return {
    ok: true,
    note: on ? "已经改回公开了" : "已经藏起来了 —— 你自己看得到，别人看不到",
  };
}
