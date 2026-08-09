"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { titles, userTitles } from "@/lib/db/schema";

export interface RenewResult {
  ok: boolean;
  error?: string;
  autoRenew?: boolean;
  note?: string;
}

/**
 * 开关自动续费。
 *
 * 单独一个 "use server" 文件：queries.ts 里还有很多同步导出，
 * 而 "use server" 文件只能导出 async 函数。
 *
 * **默认是关的，而且购买流程不会替人打开。** 一个默认开着的自动续费，
 * 会在某人早就不用这个称号的时候每月悄悄扣掉三百分 ——
 * 积分是这个站里唯一的硬通货，悄悄少掉的分会毁掉所有人对它的信任。
 */
export async function setAutoRenew(input: {
  userTitleId: string;
  autoRenew: boolean;
}): Promise<RenewResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "请先登录" };

  const row = db
    .select({ id: userTitles.id, expiresAt: userTitles.expiresAt, price: titles.price, name: titles.name })
    .from(userTitles)
    .innerJoin(titles, eq(titles.id, userTitles.titleId))
    .where(and(eq(userTitles.id, input.userTitleId), eq(userTitles.userId, user.id)))
    .get();

  if (!row) return { ok: false, error: "没有这个称号" };
  if (row.expiresAt === null) {
    return { ok: false, error: "这个称号不会到期，不需要续费" };
  }
  if (input.autoRenew && row.price === null) {
    return { ok: false, error: "这个称号没有定价，续不了" };
  }

  db.update(userTitles)
    .set({ autoRenew: input.autoRenew })
    .where(eq(userTitles.id, input.userTitleId))
    .run();

  revalidatePath("/me");
  return {
    ok: true,
    autoRenew: input.autoRenew,
    note: input.autoRenew
      ? `到期会自动扣 ${row.price} 分续「${row.name}」`
      : `已关掉自动续费，「${row.name}」到期后会摘下`,
  };
}
