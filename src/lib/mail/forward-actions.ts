"use server";

import { revalidatePath } from "next/cache";

import { and, eq } from "drizzle-orm";

import { getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { mailBoxes } from "@/lib/db/schema";
import { confirmEmailVerification, startEmailVerification } from "@/lib/mail/verify-email";

/**
 * 转发相关的三个动作。
 *
 * ⚠️ `"use server"` —— 身份只从 `getCurrentUser()` 来。
 * 尤其是下面那个开关：它接受一个 boxId，而**必须验证那个箱子是他的**，
 * 否则任何人都能打开别人箱子的转发（转到自己的邮箱去）。
 * 这是这个文件里唯一真正危险的一处。
 */

export async function setForwardEmail(input: { email: string }) {
  const user = await getCurrentUser();
  if (!user) return { ok: false as const, error: "请先登录" };
  return startEmailVerification({ userId: user.id, email: input.email });
}

export async function confirmForwardEmail(input: { code: string }) {
  const user = await getCurrentUser();
  if (!user) return { ok: false as const, error: "请先登录" };
  const r = confirmEmailVerification({ userId: user.id, code: input.code });
  if (r.ok) revalidatePath("/mail/burner");
  return r;
}

export async function setBoxForwarding(input: { boxId: string; on: boolean }) {
  const user = await getCurrentUser();
  if (!user) return { ok: false as const, error: "请先登录" };

  /*
   * ★ 归属校验和写在**同一条 where 里**。
   *
   * 先查再写的话，中间那一刻就有一条路能打开别人箱子的转发 ——
   * 而那意味着别人的信开始进你的邮箱。
   *
   * （第一版就是先写后查的：写完再确认「是不是他的」，
   * 然后返回一句「没有这个地址」—— 而那时候开关**已经打开了**。
   * 一句拒绝的话配上一次成功的写入，是这两者里最坏的组合。）
   *
   * `changes === 0` 同时覆盖了「不是他的」和「没有这个箱子」，
   * 两者给同一句话 —— 否则它是个归属探针。
   */
  const result = db
    .update(mailBoxes)
    .set({ forwardEnabled: input.on, updatedAt: Date.now() })
    .where(and(eq(mailBoxes.id, input.boxId), eq(mailBoxes.userId, user.id)))
    .run();

  if (result.changes === 0) return { ok: false as const, error: "没有这个地址" };

  revalidatePath("/mail/burner");
  return { ok: true as const };
}
