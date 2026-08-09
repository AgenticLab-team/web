import "server-only";

import { eq } from "drizzle-orm";

import { registerApproval } from "@/lib/admin/approval-registry";
import { db } from "@/lib/db";
import { roles, settings, userRoles, users } from "@/lib/db/schema";
import { invalidatePermissionCache } from "@/lib/rbac/can";
import { updateSetting } from "@/lib/settings/store";
import { isDangerousSetting, validateSettingValue } from "@/lib/settings/validate";
import { resolveDisplayName } from "@/lib/users/display-name";

/**
 * 登记可进留痕队列的动作。
 *
 * 只有这里出现过的动作能被提出 —— 见 approval-registry 里的说明。
 * 复核降级为可选留痕之后这条注册表反而更要紧：队列不再有第二个人
 * 把关，「表里只可能出现登记过的动作」是仅剩的硬约束。
 *
 * 每个 handler 的 `describe` 要写成一句人话，不是把 payload 打印出来：
 * **批准一段看不懂的 JSON 等于闭着眼点确定**，而看起来批过更糟糕。
 */

interface SettingPayload {
  key: string;
  value: string;
}

registerApproval<SettingPayload>({
  key: "settings.update.dangerous",
  label: "修改危险配置",
  permission: "system.settings",
  approvePermission: "system.approval",

  validate: (payload) => {
    const p = payload as Partial<SettingPayload>;
    if (typeof p?.key !== "string" || typeof p?.value !== "string") {
      return { ok: false, error: "参数不完整" };
    }
    if (!isDangerousSetting(p.key)) {
      // 普通配置不该进留痕队列 —— 队列里塞满琐事，重要的就被淹没了
      return { ok: false, error: "这一项不是危险项，去设置页直接改就行" };
    }

    const current = db.select().from(settings).where(eq(settings.key, p.key)).get();
    if (!current) return { ok: false, error: `未知配置项 ${p.key}` };

    // 提交时就校验一次，别让一个填错的值在队列里躺一天才被发现
    const verdict = validateSettingValue(
      {
        key: p.key,
        type: current.type,
        minValue: current.minValue,
        maxValue: current.maxValue,
      },
      p.value,
    );
    return verdict.ok ? { ok: true } : { ok: false, error: verdict.error };
  },

  describe: (payload) => {
    const current = db.select().from(settings).where(eq(settings.key, payload.key)).get();
    const label = current?.label ?? payload.key;
    return `把「${label}」从 ${current?.value ?? "?"} 改成 ${payload.value}`;
  },

  execute: async (payload, ctx) => {
    try {
      updateSetting(payload.key, payload.value, {
        actorId: ctx.actorId,
        reason: "经留痕队列批准后执行",
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
});

interface AdminGrantPayload {
  userId: string;
  roleKey: "admin" | "owner";
}

registerApproval<AdminGrantPayload>({
  key: "role.grant.admin",
  label: "授予管理员",
  permission: "role.grant.admin",
  approvePermission: "system.approval",

  validate: (payload) => {
    const p = payload as Partial<AdminGrantPayload>;
    if (typeof p?.userId !== "string") return { ok: false, error: "缺少用户" };
    if (p.roleKey !== "admin" && p.roleKey !== "owner") {
      return { ok: false, error: "只有授予管理员和站长值得进留痕队列，普通身份组直接授就行" };
    }
    if (!db.select().from(users).where(eq(users.id, p.userId)).get()) {
      return { ok: false, error: "用户不存在" };
    }
    return { ok: true };
  },

  describe: (payload) => {
    const user = db.select().from(users).where(eq(users.id, payload.userId)).get();
    const name = user
      ? resolveDisplayName([user.siteNickname, user.wxNickname], {
          wxId: user.wxId,
          fallback: payload.userId,
        })
      : payload.userId;
    return `把「${name}」提升为${payload.roleKey === "owner" ? "站长" : "管理员"}`;
  },

  execute: async (payload, ctx) => {
    const role = db.select().from(roles).where(eq(roles.key, payload.roleKey)).get();
    if (!role) return { ok: false, error: "身份组不存在" };

    /*
     * 执行时**重新检查一次是否已持有**。
     * 从提出到批准之间隔着一段时间，期间别人可能已经授过了 ——
     * 不检查的话会写出两条并存的授权记录。
     */
    const existing = db
      .select()
      .from(userRoles)
      .where(eq(userRoles.userId, payload.userId))
      .all()
      .find((r) => r.roleId === role.id && r.revokedAt === null);
    if (existing) return { ok: false, error: "这个人已经有这个身份组了" };

    db.insert(userRoles)
      .values({
        userId: payload.userId,
        roleId: role.id,
        grantedBy: ctx.actorId,
        grantReason: "经留痕队列批准后执行",
      })
      .run();

    invalidatePermissionCache();
    return { ok: true };
  },
});

/** 引入这个模块就完成注册。放一个空导出让 import 意图明确 */
export const APPROVAL_HANDLERS_LOADED = true;
