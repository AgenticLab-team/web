"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/auth/session";
import { destroyBurner, openBurner } from "@/lib/mail/burner";

/**
 * 一次性箱的网页动作。薄壳 —— 逻辑在 `burner.ts`，那里能单测。
 *
 * 这个文件里**只能导出 async 函数**。导出一个同步的常量或类型
 * 会让整个构建挂掉（"use server" 的硬规矩），而报错信息指向的
 * 是别的地方。
 */

export interface BurnerActionResult {
  ok: boolean;
  error?: string;
  address?: string;
  id?: string;
}

export async function createBurner(input: {
  localPart?: string;
  domain?: string;
}): Promise<BurnerActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "请先登录" };

  const result = openBurner({
    userId: user.id,
    localPart: input.localPart?.trim() || null,
    domain: input.domain?.trim() || null,
  });

  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath("/mail/burner");
  return { ok: true, address: result.box.displayAddress, id: result.box.id };
}

export async function discardBurner(input: { id: string }): Promise<BurnerActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "请先登录" };

  const done = destroyBurner(input.id, { userId: user.id });
  if (!done) return { ok: false, error: "没有这个箱子" };

  revalidatePath("/mail/burner");
  return { ok: true };
}
