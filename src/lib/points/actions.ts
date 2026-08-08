"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/auth/session";
import { clientIp } from "@/lib/request";

import { performCheckin, type CheckinResult } from "./checkin";

/**
 * 打卡。
 *
 * **积分只由服务端发放**，前端拿不到任何可以直接加分的入口 ——
 * 客户端能触发的加分等于没有加分规则。
 */
export async function checkinAction(): Promise<CheckinResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "请先登录" };

  const headers = await import("next/headers").then((m) => m.headers());
  const request = new Request("http://internal", { headers });
  const result = performCheckin(user, clientIp(request));

  if (result.ok) {
    revalidatePath("/");
    revalidatePath("/me");
  }
  return result;
}
