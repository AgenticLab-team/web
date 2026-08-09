"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { keywordHits, keywordSubs } from "@/lib/db/schema";
import { estimateHits7d } from "@/lib/radar/engine";
import {
  MAX_KEYWORDS_PER_USER,
  checkNoise,
  keywordKey,
  validateKeyword,
  type NoiseCheck,
} from "@/lib/radar/match";

export interface RadarResult {
  ok: boolean;
  error?: string;
  note?: string;
  noise?: NoiseCheck;
}

/** 订阅之前先看看这个词有多吵 —— 不写库 */
export async function previewKeyword(raw: string): Promise<RadarResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "请先登录" };

  const check = validateKeyword(raw);
  if (!check.ok) return { ok: false, error: check.reason };

  const noise = checkNoise(estimateHits7d(user.id, check.keyword));
  return { ok: true, noise };
}

/**
 * 添加一个关键词。
 *
 * **太吵的当场拦下。** 事后才发现的人不会回来精简关键词，
 * 他会把整个通知关掉 —— 连带着那些他真正在意的一起没了。
 */
export async function addKeyword(raw: string, force = false): Promise<RadarResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "请先登录" };

  const check = validateKeyword(raw);
  if (!check.ok) return { ok: false, error: check.reason };

  const existing = db
    .select()
    .from(keywordSubs)
    .where(
      and(eq(keywordSubs.userId, user.id), eq(keywordSubs.keywordKey, keywordKey(check.keyword))),
    )
    .get();
  if (existing) return { ok: false, error: "已经订阅过这个词了" };

  const count = db.select().from(keywordSubs).where(eq(keywordSubs.userId, user.id)).all().length;
  if (count >= MAX_KEYWORDS_PER_USER) {
    return { ok: false, error: `最多订阅 ${MAX_KEYWORDS_PER_USER} 个词，先删掉一个` };
  }

  const noise = checkNoise(estimateHits7d(user.id, check.keyword));
  // force 是用户看过噪音提示之后的明确选择，不是默认放行
  if (noise.verdict === "noisy" && !force) {
    return { ok: false, error: noise.message, noise };
  }

  db.insert(keywordSubs)
    .values({
      userId: user.id,
      keyword: check.keyword,
      keywordKey: keywordKey(check.keyword),
      hits7dAtCreate: noise.hits7d,
    })
    .run();

  revalidatePath("/radar");
  return { ok: true, note: noise.message, noise };
}

export async function removeKeyword(subId: string): Promise<RadarResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "请先登录" };

  const sub = db
    .select()
    .from(keywordSubs)
    .where(and(eq(keywordSubs.id, subId), eq(keywordSubs.userId, user.id)))
    .get();
  if (!sub) return { ok: false, error: "订阅不存在" };

  db.transaction(() => {
    db.delete(keywordHits).where(eq(keywordHits.subId, subId)).run();
    db.delete(keywordSubs).where(eq(keywordSubs.id, subId)).run();
  });

  revalidatePath("/radar");
  return { ok: true, note: `已删掉「${sub.keyword}」` };
}

/**
 * 暂停 / 恢复。
 *
 * 有「暂停」是因为删掉会连命中记录一起没 ——
 * 而一个人想安静两天，不代表他想丢掉这个词攒下来的东西。
 */
export async function toggleKeyword(subId: string): Promise<RadarResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "请先登录" };

  const sub = db
    .select()
    .from(keywordSubs)
    .where(and(eq(keywordSubs.id, subId), eq(keywordSubs.userId, user.id)))
    .get();
  if (!sub) return { ok: false, error: "订阅不存在" };

  db.update(keywordSubs).set({ enabled: !sub.enabled }).where(eq(keywordSubs.id, subId)).run();
  revalidatePath("/radar");

  return {
    ok: true,
    note: sub.enabled
      ? `「${sub.keyword}」已暂停 —— 命中记录还留着，随时可以恢复`
      : `「${sub.keyword}」已恢复`,
  };
}
