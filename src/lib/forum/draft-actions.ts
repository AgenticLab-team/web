"use server";

import { revalidatePath } from "next/cache";

import { assertNotPreviewing, getCurrentUser } from "@/lib/auth/session";

import type { DraftTarget } from "./draft-rules";
import { dropDraft } from "./drafts";

/**
 * 手动丢掉一份草稿。
 *
 * 保存走的是 `/api/forum/draft`（那条路要能被 sendBeacon 用），
 * 删除留在 server action 里：它只在人明确点了之后发生，
 * 不需要在页面被回收时还能跑。
 */
export interface DraftResult {
  ok: boolean;
  error?: string;
}

export async function discardDraft(target: DraftTarget, scope: string): Promise<DraftResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "请先登录" };
  await assertNotPreviewing();

  // dropDraft 的 where 里带 userId —— 传进来的 scope 不足以定位到别人的草稿
  dropDraft(user.id, target, scope);

  revalidatePath("/me/drafts");
  return { ok: true };
}
