"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { requireWritableAdmin } from "@/lib/admin/guard";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { featureFlags } from "@/lib/db/schema";

import { specOf, type Rollout } from "./registry";
import { invalidateFlagCache } from "./server";

/**
 * 改功能开关。
 *
 * ─────────────────────────────────────────
 * 改完必须清缓存
 * ─────────────────────────────────────────
 *
 * 判定走进程内缓存（每次渲染都要问好几次，回回打库没必要）。
 * 忘了清的话，「关掉」这个动作要等到下次重启才生效 ——
 * 而它存在的全部理由就是出事时**立刻**关掉。
 *
 * ─────────────────────────────────────────
 * 只认清单里的 key
 * ─────────────────────────────────────────
 *
 * 库里可以有别的行（历史遗留），但判定只认清单 ——
 * 允许写入清单外的 key，等于让人配置一个永远不生效的开关。
 */

export interface FlagResult {
  ok: boolean;
  error?: string;
}

const fail = (error: string): FlagResult => ({ ok: false, error });

async function save(
  key: string,
  patch: { enabled?: boolean; rollout?: Rollout; rolloutValue?: unknown },
): Promise<FlagResult> {
  // requireWritableAdmin 自己会在没权限时跳走，这里拿到的一定是有权限的
  const admin = await requireWritableAdmin("system.flags");

  const spec = specOf(key);
  if (!spec) return fail("没有这个开关");

  const before = db.select().from(featureFlags).where(eq(featureFlags.key, key)).get();
  const next = {
    enabled: patch.enabled ?? before?.enabled ?? spec.status === "wired",
    rollout: patch.rollout ?? ((before?.rollout ?? "all") as Rollout),
    rolloutValue: patch.rolloutValue ?? before?.rolloutValue ?? null,
    description: spec.effect,
    updatedAt: Date.now(),
    updatedBy: admin.user.id,
  };

  if (before) {
    db.update(featureFlags).set(next).where(eq(featureFlags.key, key)).run();
  } else {
    // 库里没有这一行 —— 之前走的是清单默认值，现在落一行下来
    db.insert(featureFlags).values({ key, ...next }).run();
  }

  invalidateFlagCache();

  audit(
    { actorId: admin.user.id },
    {
      action: "system.flag.set",
      targetType: "feature_flag",
      targetId: key,
      targetLabel: spec.label,
      before: before
        ? { enabled: before.enabled, rollout: before.rollout, rolloutValue: before.rolloutValue }
        : { missing: true },
      after: { enabled: next.enabled, rollout: next.rollout, rolloutValue: next.rolloutValue },
    },
  );

  /*
   * 整站 revalidate：开关管的是导航和一批页面，
   * 只 revalidate 后台那一页的话，改完之后自己看到的还是旧导航。
   */
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function setFlagEnabled(key: string, enabled: boolean): Promise<FlagResult> {
  return save(key, { enabled });
}

export async function setFlagRollout(
  key: string,
  rollout: Rollout,
  value: unknown,
): Promise<FlagResult> {
  if (!["all", "role", "user", "percent"].includes(rollout)) return fail("灰度方式不对");
  return save(key, { rollout, rolloutValue: value });
}
