"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/auth/session";
import { openAlias, ownedDomains } from "@/lib/mail/alias";

/**
 * 自有域名上开一个长期地址。
 *
 * ⚠️ 这个文件是 `"use server"` —— **每个导出的异步函数都能被客户端直接调**。
 * 所以这里一律先 `getCurrentUser()` 拿身份，绝不接受调用方传进来的 userId：
 * 那样的参数就是一道后门。
 */
export async function createAlias(input: {
  domain: string;
  localPart: string;
}): Promise<{ ok: true; address: string } | { ok: false; error: string }> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "请先登录" };

  const r = openAlias({
    userId: user.id,
    domain: input.domain.trim(),
    localPart: input.localPart.trim(),
  });
  if (!r.ok) return { ok: false, error: r.error };

  revalidatePath("/mail/burner");
  return { ok: true, address: r.box.address };
}

/** 我拥有哪些域名 —— 界面靠它决定要不要显示「开长期地址」那一块 */
export async function myDomains(): Promise<{ domain: string }[]> {
  const user = await getCurrentUser();
  if (!user) return [];
  return ownedDomains(user.id).map((d) => ({ domain: d.domain }));
}
