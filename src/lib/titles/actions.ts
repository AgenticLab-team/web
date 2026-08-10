"use server";

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { requireWritableAdmin } from "@/lib/admin/guard";
import { audit } from "@/lib/audit";
import { getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { titles, userTitles, users } from "@/lib/db/schema";
import { notify } from "@/lib/forum/notify";
import { grantPoints } from "@/lib/points/ledger";
import { checkEquip, checkGrant, checkPurchase, expiryFor, type TitleSpec } from "@/lib/titles/rules";
import { holderCount, titlesOf } from "@/lib/titles/queries";

/**
 * 称号的写操作。
 *
 * 授予要通知本人 —— 悄悄发一个称号，等于没发：
 * 用户不会主动去个人页翻有没有新东西。
 */

export interface TitleResult {
  ok: boolean;
  error?: string;
}

const fail = (error: string): TitleResult => ({ ok: false, error });

function toSpec(row: typeof titles.$inferSelect): TitleSpec {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    rarity: row.rarity,
    source: row.source,
    price: row.price,
    rentDays: row.rentDays,
    limitCount: row.limitCount,
    enabled: row.enabled,
  };
}

/** 佩戴或摘下。传 null 表示摘下 */
export async function equipTitle(titleId: string | null): Promise<TitleResult> {
  const user = await getCurrentUser();
  if (!user) return fail("请先登录");

  const owned = titlesOf(user.id);
  const check = checkEquip({
    titleId,
    held: owned.map((o) => ({
      titleId: o.titleId,
      expiresAt: o.expiresAt,
      revokedAt: o.revokedAt,
    })),
    now: Date.now(),
  });
  if (!check.ok) return fail(check.error!);

  db.update(users)
    .set({ activeTitleId: titleId, updatedAt: Date.now() })
    .where(eq(users.id, user.id))
    .run();

  revalidatePath("/me");
  return { ok: true };
}

export async function grantTitle(input: {
  userId: string;
  titleKey: string;
  reason: string;
}): Promise<TitleResult> {
  const admin = await requireWritableAdmin("user.title.grant");

  const title = db.select().from(titles).where(eq(titles.key, input.titleKey)).get();
  if (!title) return fail("称号不存在");

  const already = db
    .select()
    .from(userTitles)
    .where(
      and(
        eq(userTitles.userId, input.userId),
        eq(userTitles.titleId, title.id),
        isNull(userTitles.revokedAt),
      ),
    )
    .get();

  const check = checkGrant({
    title: toSpec(title),
    currentHolders: holderCount(title.id),
    alreadyHeld: already !== undefined,
    reason: input.reason,
  });
  if (!check.ok) return fail(check.error!);

  const reason = input.reason.trim();
  db.insert(userTitles)
    .values({
      userId: input.userId,
      titleId: title.id,
      source: title.source,
      grantedBy: admin.user.id,
      grantReason: reason,
      expiresAt: expiryFor(toSpec(title), Date.now()),
    })
    .run();

  // 悄悄发一个称号等于没发 —— 用户不会主动去翻个人页
  notify({
    userId: input.userId,
    type: "title",
    groupKey: `title:${title.id}`,
    title: `你获得了称号「${title.name}」`,
    body: reason,
    link: "/me",
    actorId: admin.user.id,
  });

  audit({ actorId: admin.user.id }, {
    action: "user.title.grant",
    targetType: "user",
    targetId: input.userId,
    after: { title: title.key },
    reason,
  });

  revalidatePath(`/admin/users/${input.userId}`);
  revalidatePath("/admin/titles");
  return { ok: true };
}

export async function revokeTitle(input: {
  userTitleId: string;
  reason: string;
}): Promise<TitleResult> {
  const admin = await requireWritableAdmin("user.title.grant");

  const reason = input.reason.trim();
  if (!reason) return fail("必须填写理由");

  const row = db.select().from(userTitles).where(eq(userTitles.id, input.userTitleId)).get();
  if (!row) return fail("找不到这条授予记录");
  if (row.revokedAt !== null) return fail("已经收回过了");

  db.transaction((tx) => {
    tx.update(userTitles)
      .set({ revokedAt: Date.now(), revokedBy: admin.user.id, revokeReason: reason })
      .where(eq(userTitles.id, input.userTitleId))
      .run();

    // 正戴着的话要一并摘掉，否则收回之后名字后面还挂着
    tx.update(users)
      .set({ activeTitleId: null })
      .where(and(eq(users.id, row.userId), eq(users.activeTitleId, row.titleId)))
      .run();
  });

  audit({ actorId: admin.user.id }, {
    action: "user.title.grant",
    targetType: "user",
    targetId: row.userId,
    before: { title: row.titleId },
    after: { revoked: true },
    reason,
  });

  revalidatePath(`/admin/users/${row.userId}`);
  return { ok: true };
}

/** 购买称号。积分在这里被真正销毁 —— 这是主要的回收口 */
export async function purchaseTitle(titleKey: string): Promise<TitleResult> {
  const user = await getCurrentUser();
  if (!user) return fail("请先登录");

  const title = db.select().from(titles).where(eq(titles.key, titleKey)).get();
  if (!title) return fail("称号不存在");

  const already = db
    .select()
    .from(userTitles)
    .where(
      and(
        eq(userTitles.userId, user.id),
        eq(userTitles.titleId, title.id),
        isNull(userTitles.revokedAt),
      ),
    )
    .get();

  const check = checkPurchase({
    title: toSpec(title),
    balance: user.points,
    currentHolders: holderCount(title.id),
    alreadyHeld: already !== undefined,
  });
  if (!check.ok) return fail(check.error!);

  const price = title.price!;

  /*
   * 先扣分再发称号。反过来的话，扣分失败会留下一个白拿的称号 ——
   * 而「有人白拿了」比「有人多花了一次点击」难收拾得多。
   */
  const paid = grantPoints({
    userId: user.id,
    delta: -price,
    reason: `购买称号「${title.name}」`,
    ruleKey: "title",
    refType: "title",
    refId: title.id,
    idempotencyKey: `title:${user.id}:${title.id}:${Date.now()}`,
  });
  if (!paid.ok) return fail(paid.error ?? "扣分失败");

  db.insert(userTitles)
    .values({
      userId: user.id,
      titleId: title.id,
      source: "purchase",
      pricePaid: price,
      expiresAt: expiryFor(toSpec(title), Date.now()),
    })
    .run();

  revalidatePath("/me");
  return { ok: true };
}
