"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/auth/session";
import { claimAddress, renewClaim, slotStatus } from "@/lib/mail/claim";
import { claimableDomains } from "@/lib/mail/claim-queries";

/**
 * 申领一个长期地址。
 *
 * ⚠️ `"use server"` —— 每个导出的异步函数都能被客户端直接调。
 * 所以身份只从 `getCurrentUser()` 来，绝不接受调用方传进来的 userId。
 */
export async function claim(input: {
  domain: string;
  localPart: string;
}): Promise<{ ok: true; address: string; paid: number } | { ok: false; error: string }> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "请先登录" };

  const r = claimAddress({
    userId: user.id,
    domain: input.domain.trim(),
    localPart: input.localPart.trim(),
  });
  if (!r.ok) return { ok: false, error: r.error };

  revalidatePath("/mail/burner");
  return { ok: true, address: r.address, paid: r.paid };
}

/** 申领那一块要显示的东西：我还有几个槽位、有哪些域名可申领 */
export async function claimOptions(): Promise<{
  slots: { total: number; used: number };
  domains: { domain: string; tier: string; rent: number; minLevel: number }[];
}> {
  const user = await getCurrentUser();
  if (!user) return { slots: { total: 0, used: 0 }, domains: [] };
  return { slots: slotStatus(user.id), domains: claimableDomains() };
}

/** 续一年。等级和槽位都不查 —— 这个地址已经是他的了，见 renewClaim 上那段 */
export async function renew(input: {
  boxId: string;
}): Promise<{ ok: true; expiresAt: number; paid: number } | { ok: false; error: string }> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "请先登录" };

  const r = renewClaim({ userId: user.id, boxId: input.boxId });
  if (!r.ok) return { ok: false, error: r.error };

  revalidatePath("/mail/burner");
  return r;
}
