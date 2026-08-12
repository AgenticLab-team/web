"use server";

import { revalidatePath } from "next/cache";

import { requireWritableAdmin } from "@/lib/admin/guard";
import { audit } from "@/lib/audit";
import { getCurrentUser } from "@/lib/auth/session";

import { normalizeScopes } from "./rules";
import { createToken, grantSend, revokeSend, revokeToken, tokensOf } from "./store";

/**
 * 令牌和授权的写操作。
 *
 * ─────────────────────────────────────────
 * 两类操作，两种把关
 * ─────────────────────────────────────────
 *
 * · **令牌**是自己的东西，本人就能建和撤 —— 它不会带来任何
 *   他本来没有的权限（`groups:send` 也要另有逐群授权才发得出去）
 * · **逐群发送授权**是站长给的，所以走管理员那道门
 */

export type TokenActionResult =
  | { ok: true; plaintext?: string; note: string }
  | { ok: false; error: string };

/** 一个人最多几把。不设上限的话，列表会变成没人看的一堆 */
const MAX_TOKENS = 10;

export async function createTokenAction(
  name: string,
  scopes: string[],
): Promise<TokenActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "先登录" };

  const live = tokensOf(user.id).filter((t) => t.revokedAt === null);
  if (live.length >= MAX_TOKENS) {
    return { ok: false, error: `最多同时有 ${MAX_TOKENS} 把，先撤掉几把不用的` };
  }

  const wanted = normalizeScopes(scopes);
  if (wanted.length === 0) return { ok: false, error: "至少要选一项权限" };

  const created = createToken({ userId: user.id, name, scopes: wanted });

  /*
   * 记审计。**不记明文**，只记 id、名字和 scope ——
   * 审计日志的读者比令牌本身多得多。
   */
  audit(
    { actorId: user.id },
    {
      action: "api_token.create",
      targetType: "api_token",
      targetId: created.id,
      after: { name, scopes: wanted },
      reason: "本人创建开放 API 令牌",
    },
  );

  revalidatePath("/me/api");
  return {
    ok: true,
    plaintext: created.plaintext,
    /*
     * 说清楚「只显示这一次」。
     *
     * 不说的话，人会关掉这个页面然后回来找 —— 而那时候
     * 我们能给出的只有一句「看不到了，重新建一把吧」，
     * 那是一次本来可以避免的挫败。
     */
    note: "**这串东西只显示这一次**，关掉就再也看不到了。现在就存到你要用它的地方去。",
  };
}

export async function revokeTokenAction(id: string): Promise<TokenActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "先登录" };

  if (!revokeToken(id, user.id, "本人撤销")) {
    return { ok: false, error: "没有这把令牌，或者它已经撤销过了" };
  }

  audit(
    { actorId: user.id },
    { action: "api_token.revoke", targetType: "api_token", targetId: id, reason: "本人撤销" },
  );
  revalidatePath("/me/api");
  return { ok: true, note: "撤销了。用这串令牌的地方会立刻开始报 401" };
}

/* ── 逐群发送授权（站长） ──────────────────────────────── */

export type GrantResult = { ok: true; note: string } | { ok: false; error: string };

/**
 * 一次授权多个群。
 *
 * ═════════════════════════════════════════
 * 「全部群」是**展开成当时那几个**，不是一条通配授权
 * ═════════════════════════════════════════
 *
 * 通配听起来更省事：以后新建群自动包含，收回也只用删一行。
 * 但它有一个很难发现的后果 —— **授权会自己长大**。
 *
 * 授权理由那一栏写的是「他在维护打卡机器人」，站长当时心里过了一遍的是
 * 那十二个群。三个月后多了一个群，通配授权会把它一起给出去，
 * 而这件事没有人做过决定、审计日志里也没有对应的一行。
 *
 * 所以这里存的永远是**逐群的具体行**：勾「全选」等于一次点十二下，
 * 审计日志里就是十二条，收回也一个个来。以后新加的群不在里面 ——
 * 界面上写清楚了这句话。
 */
export async function grantSendManyAction(input: {
  convIds: string[];
  userId: string;
  reason: string;
  perMinute?: number | null;
  perHour?: number | null;
  perDay?: number | null;
}): Promise<GrantResult> {
  const admin = await requireWritableAdmin("system.settings");

  if (!input.reason.trim()) {
    return { ok: false, error: "要写清楚为什么给他这些群的发送权限" };
  }
  /*
   * 去重。界面上不该出现重复，但这个函数是客户端可以直接调的
   * （见 server-action-surface 那份守卫）—— 重复的话审计日志里
   * 会出现两条一模一样的记录，而那会让人以为授权过两次。
   */
  const convIds = [...new Set(input.convIds.filter((c) => typeof c === "string" && c.trim()))];
  if (convIds.length === 0) return { ok: false, error: "至少选一个群" };

  const limits = {
    perMinute: input.perMinute ?? null,
    perHour: input.perHour ?? null,
    perDay: input.perDay ?? null,
  };

  for (const convId of convIds) {
    grantSend({
      convId,
      userId: input.userId,
      grantedBy: admin.user.id,
      reason: input.reason,
      limits,
    });

    /*
     * **一个群一条审计**，不是一条写着「批量授权 12 个群」。
     *
     * 收回是逐群的，所以审计也必须逐群 —— 否则「这个群他是什么时候
     * 拿到权限的」这个问题，在一条批量记录面前答不上来。
     */
    audit(
      { actorId: admin.user.id },
      {
        action: "group.send_grant",
        targetType: "user",
        targetId: input.userId,
        after: { convId, ...limits },
        reason: input.reason,
      },
    );
  }

  revalidatePath("/admin/api");
  return {
    ok: true,
    note:
      convIds.length === 1
        ? "给了。他现在可以通过网页或 API 往这个群发消息，每条都会带代发署名"
        : `给了 ${convIds.length} 个群。每条发出去的都会带代发署名 —— 以后新加的群不在里面，要另外授权`,
  };
}

export async function grantSendAction(input: {
  convId: string;
  userId: string;
  reason: string;
  perMinute?: number | null;
  perHour?: number | null;
  perDay?: number | null;
}): Promise<GrantResult> {
  const admin = await requireWritableAdmin("system.settings");

  if (!input.reason.trim()) {
    /*
     * 必填理由。这是一次**把「以机器人身份说话」的能力交出去**的操作，
     * 而半年后回头看的时候，「为什么给了他」是唯一要问的问题。
     */
    return { ok: false, error: "要写清楚为什么给他这个群的发送权限" };
  }

  grantSend({
    convId: input.convId,
    userId: input.userId,
    grantedBy: admin.user.id,
    reason: input.reason,
    limits: {
      perMinute: input.perMinute ?? null,
      perHour: input.perHour ?? null,
      perDay: input.perDay ?? null,
    },
  });

  audit(
    { actorId: admin.user.id },
    {
      action: "group.send_grant",
      targetType: "user",
      targetId: input.userId,
      after: {
        convId: input.convId,
        perMinute: input.perMinute ?? null,
        perHour: input.perHour ?? null,
        perDay: input.perDay ?? null,
      },
      reason: input.reason,
    },
  );

  revalidatePath("/admin/api");
  return { ok: true, note: "给了。他现在可以通过网页或 API 往这个群发消息，每条都会带代发署名" };
}

export async function revokeSendAction(convId: string, userId: string): Promise<GrantResult> {
  const admin = await requireWritableAdmin("system.settings");

  if (!revokeSend(convId, userId)) {
    return { ok: false, error: "他本来就没有这个群的发送权限" };
  }

  audit(
    { actorId: admin.user.id },
    {
      action: "group.send_revoke",
      targetType: "user",
      targetId: userId,
      after: { convId },
      reason: "收回群发送授权",
    },
  );

  revalidatePath("/admin/api");
  return { ok: true, note: "收回了。他手里的令牌还在，但发不到这个群了" };
}
