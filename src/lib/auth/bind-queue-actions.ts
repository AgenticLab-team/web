"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { requireWritableAdmin } from "@/lib/admin/guard";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { bindCodes, users } from "@/lib/db/schema";
import { nekobot } from "@/lib/nekobot/client";

import { canManualBind } from "./bind-queue";
import {
  FRIEND_ACCEPT_ACTION,
  applicantActivity,
  boundAccountOf,
  currentAcceptBudget,
} from "./bind-queue-queries";

export type QueueResult = { ok: true; note: string } | { ok: false; error: string };

const fail = (error: string): QueueResult => ({ ok: false, error });

/**
 * 通过一个好友申请。
 *
 * ─────────────────────────────────────────
 * 服务端不拦，但账要算清楚（2026-08 站长指令）
 * ─────────────────────────────────────────
 *
 * 这里原来有一道硬性限速（每天 5 个、间隔 5 分钟）。站长明确要求
 * 管理接口不设限速 —— 「我有数」。于是拦截去掉。
 *
 * 但 currentAcceptBudget 的计算全部保留:微信对机器人频繁加好友的风控
 * 是**真实发生过**的失败模式,那条限制本来防的是猫娘账号被封,
 * 不是不信任管理员的判断。判断交回给人的前提是**人得看见数字**。
 *
 * 拿掉拦截之后,「按钮被连点」不再有服务端兜底:每一下都会真的打到上游。
 * 所以成功的返回里必须回显今天的累计,让连点的人第一时间看见自己点了几下。
 */
export async function acceptFriendRequestAction(input: {
  wxId: string;
  reason: string;
}): Promise<QueueResult> {
  const admin = await requireWritableAdmin("user.bind.approve");

  if (input.reason.trim().length < 4) {
    return fail("写一句为什么要通过他（至少 4 个字）");
  }

  try {
    await nekobot.acceptFriendRequest(input.wxId);
  } catch (error) {
    /*
     * 上游失败**不记审计**。
     *
     * 界面上「今天已经通过几个」是从审计日志数出来的 ——
     * 记了失败的话那个数字会虚高，而它现在是风控判断的**唯一**依据：
     * 没真的发出去的请求不该混进去。
     */
    return fail(`上游拒绝了：${error instanceof Error ? error.message : String(error)}`);
  }

  audit(
    { actorId: admin.user.id },
    {
      action: FRIEND_ACCEPT_ACTION,
      targetType: "wx_id",
      targetId: input.wxId,
      reason: input.reason,
    },
  );

  revalidatePath("/admin/binds");
  const after = currentAcceptBudget();
  return { ok: true, note: `已通过。${after.reason}` };
}

/**
 * 手动把一次没完成的绑定归到某个微信号上。
 *
 * ─────────────────────────────────────────
 * 这里是整站入口规则的最后一道
 * ─────────────────────────────────────────
 *
 * 手动绑定绕过了验证码，而验证码本身就是「这个人在群里」的证明。
 * 所以这里把那个证明**硬性地重新要一遍**（canManualBind）——
 * 不在任何群里就是不行，没有「管理员确认过」这种例外。
 *
 * 留了例外的话，「只有群成员能登录」的实际含义就变成
 * 「只有群成员、或者某个管理员愿意点通过的人能登录」，
 * 那前半句就不再是一条规则，只是一个默认值。
 */
export async function manualBindAction(input: {
  bindCodeId: string;
  wxId: string;
  reason: string;
}): Promise<QueueResult> {
  const admin = await requireWritableAdmin("user.bind.manual");

  const wxId = input.wxId.trim();
  if (!wxId) return fail("要填微信号");

  const bind = db.select().from(bindCodes).where(eq(bindCodes.id, input.bindCodeId)).get();
  if (!bind) return fail("找不到这次绑定请求");
  if (bind.matchedAt) return fail("这次请求已经完成了");

  const check = canManualBind({
    activity: applicantActivity(wxId),
    alreadyBoundTo: boundAccountOf(wxId),
    reason: input.reason,
  });
  if (!check.ok) return fail(check.error);

  const now = Date.now();
  if (bind.expiresAt < now) {
    return fail("这个码已经过期了 —— 让他重新取一次，别把过期的码放行");
  }

  db.update(bindCodes)
    .set({
      matchedAt: now,
      matchedChannel: "direct_message",
      matchedWxId: wxId,
      matchedSource: `管理员手动绑定：${input.reason.trim()}`,
    })
    .where(eq(bindCodes.id, bind.id))
    .run();

  if (bind.userId) {
    db.update(users).set({ wxId, updatedAt: now }).where(eq(users.id, bind.userId)).run();
  }

  audit(
    { actorId: admin.user.id },
    {
      action: "user.bind.manual",
      targetType: "wx_id",
      targetId: wxId,
      after: { bindCodeId: bind.id, userId: bind.userId },
      reason: input.reason,
    },
  );

  revalidatePath("/admin/binds");
  return { ok: true, note: `已把这次请求绑到 ${wxId}` };
}

/**
 * 作废一次绑定请求。
 *
 * 「不处理」和「处理过了、决定不放行」在队列上长得一样，
 * 但对下一个看队列的人完全不同 —— 所以要能标掉，而且要留下理由。
 */
export async function dismissBindAction(input: {
  bindCodeId: string;
  reason: string;
}): Promise<QueueResult> {
  const admin = await requireWritableAdmin("user.bind.approve");

  const bind = db.select().from(bindCodes).where(eq(bindCodes.id, input.bindCodeId)).get();
  if (!bind) return fail("找不到这次绑定请求");
  if (bind.matchedAt) return fail("这次请求已经完成了，作废不了");
  if (input.reason.trim().length < 2) return fail("写一句为什么");

  db.update(bindCodes).set({ status: "revoked" }).where(eq(bindCodes.id, bind.id)).run();

  audit(
    { actorId: admin.user.id },
    {
      action: "user.bind.dismiss",
      targetType: "bind_code",
      targetId: bind.id,
      reason: input.reason,
    },
  );

  revalidatePath("/admin/binds");
  return { ok: true, note: "已作废" };
}
