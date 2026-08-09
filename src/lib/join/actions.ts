"use server";

import { and, desc, eq, gt } from "drizzle-orm";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { requireWritableAdmin } from "@/lib/admin/guard";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { joinRequests } from "@/lib/db/schema";

import { DAY_MS, SUBMITTED_MESSAGE, checkJoinRequest, checkRate } from "./rules";

export type JoinResult = { ok: true; message: string } | { ok: false; error: string };

/**
 * 提交一份加入申请。**不需要登录。**
 *
 * ─────────────────────────────────────────
 * 成功和「已经是成员」返回同一句话
 * ─────────────────────────────────────────
 *
 * 这里不去查这个微信号在不在群里、有没有账号、之前有没有申请过 ——
 * 不是查不到，是**查了就会想说出来**。而任何一句
 * 「你已经是成员了」「你已经申请过了」都在回答一个陌生人不该能问的问题：
 * 一个个试就能把成员名单摸出来。
 *
 * 判断留给管理员那一侧，那边是登录之后才看得到的。
 */
export async function submitJoinRequest(input: {
  wxId: string;
  reason: string;
  contact?: string;
}): Promise<JoinResult> {
  const check = checkJoinRequest(input);
  if (!check.ok) return { ok: false, error: check.error };

  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = h.get("user-agent") ?? null;

  /*
   * 限流按 IP。
   *
   * 这是全站唯一未认证可写的入口 —— 不限的话它就是个留言板。
   * 站长要求「管理接口别有 rate limit」，而这条是面向陌生人的公开接口，
   * 不在那个范围里。
   */
  if (ip) {
    const recent = db
      .select({ createdAt: joinRequests.createdAt })
      .from(joinRequests)
      .where(and(eq(joinRequests.ip, ip), gt(joinRequests.createdAt, Date.now() - DAY_MS)))
      .all()
      .map((r) => r.createdAt);

    const verdict = checkRate(recent, Date.now());
    if (!verdict.allowed) return { ok: false, error: verdict.message };
  }

  db.insert(joinRequests)
    .values({
      wxId: check.wxId,
      reason: check.reason,
      contact: check.contact,
      ip,
      userAgent,
    })
    .run();

  revalidatePath("/admin/binds");
  return { ok: true, message: SUBMITTED_MESSAGE };
}

export type HandleResult = { ok: true; note: string } | { ok: false; error: string };

/**
 * 管理员处理一份申请。
 *
 * 「已处理」和「拒绝」都只是**标记**，不产生任何账号 ——
 * 这个站的入口只有群，账号是跟着群成员身份来的。
 * 真正让人进来的动作发生在微信里（把人拉进群），
 * 这里只负责让队列不再重复出现同一个人。
 */
export async function handleJoinRequest(input: {
  id: string;
  status: "handled" | "rejected";
  note: string;
}): Promise<HandleResult> {
  const admin = await requireWritableAdmin("user.bind.approve");

  const row = db.select().from(joinRequests).where(eq(joinRequests.id, input.id)).get();
  if (!row) return { ok: false, error: "找不到这份申请" };
  if (row.status !== "pending") return { ok: false, error: "这份申请已经处理过了" };
  if (input.note.trim().length < 2) return { ok: false, error: "写一句处理说明" };

  db.update(joinRequests)
    .set({
      status: input.status,
      handledBy: admin.user.id,
      handledAt: Date.now(),
      note: input.note.trim(),
    })
    .where(eq(joinRequests.id, input.id))
    .run();

  audit(
    { actorId: admin.user.id },
    {
      action: "user.join_request.handle",
      targetType: "join_request",
      targetId: input.id,
      targetLabel: row.wxId,
      after: { status: input.status },
      reason: input.note.trim(),
    },
  );

  revalidatePath("/admin/binds");
  return { ok: true, note: input.status === "handled" ? "已标记处理" : "已拒绝" };
}

/** 待处理的申请数 —— 后台待办用 */
export async function pendingJoinCount(): Promise<number> {
  return db.select().from(joinRequests).where(eq(joinRequests.status, "pending")).all().length;
}

/** 最近的申请，管理员看 */
export async function recentJoinRequests(limit = 30) {
  return db
    .select()
    .from(joinRequests)
    .orderBy(desc(joinRequests.createdAt))
    .limit(limit)
    .all();
}
