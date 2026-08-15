import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { mailBoxes, mailDomains, mailEvents } from "@/lib/db/schema";

import { buildAddress, checkLocalPart, MAIL_BANWORD_KINDS } from "./address-rules";
import { MAIL_BOX_ALIVE_STATUSES } from "./kinds";
import { mailConfig } from "./config";
import { listBanwords } from "./admin-queries";

/**
 * 自有域名上的**长期地址**。
 *
 * ═════════════════════════════════════════
 * 它和一次性箱是两种东西，不只是时长不同
 * ═════════════════════════════════════════
 *
 *   一次性箱  24 小时、随机或长前缀、零摩擦 —— 它是**一次动作**
 *   长期别名  不过期、短前缀随便挑、只能开在自己的域名上 —— 它是**一个地址**
 *
 * 合成一个靠 `expires_at` 区分的话，「这个人有几个长期地址」
 * 这种判断要在每处重写一遍 `if (ttl > 1 天)`（见 `kinds.ts` 里那段）。
 *
 * ─────────────────────────────────────────
 * 为什么只开在自己的域名上
 * ─────────────────────────────────────────
 *
 * 公共池上的长期地址是**申领**，那要先有槽位、有积分、有价格
 * （`mail_slots` 那张表就是为它准备的，现在还零读零写）。
 * 那一整套是另一件事。
 *
 * 而「我自己的域名」不需要任何经济设计：域名是他的，
 * 上面开几个地址是他自己的事 —— 唯一要判的是**这域名真的是他的**。
 *
 * 所以这个函数只做一件事，而那件事只有一个判据。
 */

export type OpenAliasResult =
  | { ok: true; box: { id: string; address: string; localPart: string; domain: string } }
  | { ok: false; error: string };

export function openAlias(input: {
  userId: string;
  domain: string;
  localPart: string;
}): OpenAliasResult {
  const domainRow = db
    .select()
    .from(mailDomains)
    .where(eq(mailDomains.domain, input.domain))
    .get();

  /*
   * 「没有这个域名」和「不是你的」**必须是同一句话**，见下面那段。
   * 分成两句写的话很自然（这里就是），而它当场就成了一个归属探针。
   */
  const NOT_YOURS = "没有这个域名，或者它不是你的";

  if (!domainRow) return { ok: false, error: NOT_YOURS };

  /*
   * ★ **唯一的判据：这个域名是不是你的。**
   *
   * 不查「是不是管理员」也不查 `allowClaim` —— 那两个是公共池那条路
   * 才要问的问题。这里问的是所有权，而所有权只有一个答案。
   */
  if (domainRow.ownerUserId !== input.userId) {
    /*
     * 「不是你的」和「没有这个域名」给同一句话。
     *
     * 分开说的话，这就成了一个「谁拥有哪个域名」的探针 ——
     * 而域名列表本身是不公开的（后台才看得到主人）。
     */
    return { ok: false, error: NOT_YOURS };
  }

  if (!domainRow.enabled) return { ok: false, error: "这个域名停用了，先去后台打开" };
  if (domainRow.kind === "blocked") {
    // 连 MX 都没配，开出来的地址永远收不到信 —— 那比开不出来更让人困惑
    return { ok: false, error: "这个域名连 MX 都没配，开了也收不到信" };
  }

  const verdict = checkLocalPart(input.localPart, {
    purpose: "claim",
    banwords: listBanwords().map((b) => ({
      word: b.word,
      kind: b.kind as (typeof MAIL_BANWORD_KINDS)[number],
    })),
  });
  if (!verdict.ok) return { ok: false, error: verdict.error ?? "这个前缀不行" };

  // 存的是 punycode 形式（收信按它匹配）；显示用的那一份是算出来的，不存
  const address = buildAddress(verdict.local, domainRow.punycode);
  const config = mailConfig();

  const existing = db
    .select({ id: mailBoxes.id })
    .from(mailBoxes)
    .where(eq(mailBoxes.address, address))
    .get();
  if (existing) return { ok: false, error: "这个地址已经开过了" };

  const inserted = db
    .insert(mailBoxes)
    .values({
      userId: input.userId,
      localPart: verdict.local,
      domain: domainRow.domain,
      address,
      kind: "alias",
      custom: true,
      /*
       * **不过期。**
       *
       * 这是它和一次性箱最大的差别，也是唯一一处要小心的地方：
       * `expires_at` 为 null 的箱子不会被回收任务扫到（那个任务查的是
       * `expires_at < now`），所以它会一直在 —— 而这正是「地址」该有的样子。
       */
      expiresAt: null,
      quotaBytes: config.boxMaxBytes,
      /*
       * 长期地址**不静音**。
       *
       * 一次性箱静音是因为人正盯着页面等那一封；
       * 而长期地址是「别人可能随时给你写信」——不叮一下的话，
       * 这个功能等于一个要靠你自己记得去刷的收件箱。
       */
      muted: false,
      status: "active",
    })
    .returning()
    .get();

  db.insert(mailEvents)
    .values({
      boxId: inserted.id,
      domain: domainRow.domain,
      event: "alias_created",
      actorId: input.userId,
      actorKind: "user",
      detail: { address },
    })
    .run();

  return {
    ok: true,
    box: {
      id: inserted.id,
      // 显示用中文域名那一份 —— `displayAddress` 全站都是算出来的，不落库
      address: `${inserted.localPart}@${domainRow.domain}`,
      localPart: inserted.localPart,
      domain: inserted.domain,
    },
  };
}

/** 这个人拥有哪些域名 —— 决定他能不能开长期地址，以及开在哪 */
export function ownedDomains(userId: string): { domain: string; punycode: string }[] {
  return db
    .select({ domain: mailDomains.domain, punycode: mailDomains.punycode })
    .from(mailDomains)
    .where(and(eq(mailDomains.ownerUserId, userId), eq(mailDomains.enabled, true)))
    .all();
}

export interface AliasView {
  id: string;
  address: string;
  domain: string;
  messageCount: number;
  unreadCount: number;
  lastReceivedAt: number | null;
}

/**
 * 我的长期地址。
 *
 * 和 `listBurners` 分开而不是加个参数：两者**排序口径不同** ——
 * 一次性箱按「还剩多久」排（快过期的要先看见），
 * 长期地址按「最近收到信」排（它不会过期，急的是有没有新信）。
 */
export function listAliases(userId: string): AliasView[] {
  return db
    .select()
    .from(mailBoxes)
    .where(
      and(
        eq(mailBoxes.userId, userId),
        eq(mailBoxes.kind, "alias"),
        eq(mailBoxes.status, "active"),
      ),
    )
    .all()
    .map((b) => ({
      id: b.id,
      // 显示用那一份是算出来的，库里存的是 punycode
      address: `${b.localPart}@${b.domain}`,
      domain: b.domain,
      messageCount: b.messageCount,
      unreadCount: b.unreadCount,
      lastReceivedAt: b.lastReceivedAt,
    }))
    .sort((a, b) => (b.lastReceivedAt ?? 0) - (a.lastReceivedAt ?? 0));
}


/**
 * 关掉一个自有域名地址。
 *
 * ═════════════════════════════════════════
 * 这个功能原来**整个不存在**
 * ═════════════════════════════════════════
 *
 * 开得出来、关不掉 —— 站长的原话是「还没法删除」。
 * 而自有域名上的地址是免费开的，那就意味着一个手滑的前缀
 * （`qaq@`、测试用的 `aaa@`）会永远挂在他自己的域名上。
 *
 * ─────────────────────────────────────────
 * 走 `revoked`，不删行
 * ─────────────────────────────────────────
 *
 * 地址上有唯一索引，而且信是挂在箱子 id 上的。真删行的话：
 * 已经收到的信要么跟着没（那是他的东西，不该替他决定），
 * 要么变成孤儿。标成 revoked 之后收信侧不再匹配它，
 * 而历史留在原地 —— 和一次性箱那条「扔掉」是同一套。
 *
 * 同一个前缀之后还能再开：`revoked` 的行不参与「地址被占了」的判断。
 */
export function closeAlias(input: { userId: string; boxId: string }): { ok: boolean; error?: string } {
  /*
   * 归属和存在性用**同一条 where** 判掉。
   *
   * 分两步查的话（先查在不在、再查是不是你的）就会分出两句不同的错误，
   * 而那两句合起来是一个「这个 id 存不存在」的探针。
   * 这一条和 `readMessage` 是同一个写法。
   */
  const changes = db
    .update(mailBoxes)
    .set({ status: "revoked", updatedAt: Date.now() })
    .where(
      and(
        eq(mailBoxes.id, input.boxId),
        eq(mailBoxes.userId, input.userId),
        eq(mailBoxes.kind, "alias"),
        inArray(mailBoxes.status, MAIL_BOX_ALIVE_STATUSES),
      ),
    )
    .run().changes;

  if (changes === 0) return { ok: false, error: "没有这个地址，或者它不是你的" };

  db.insert(mailEvents)
    .values({
      boxId: input.boxId,
      event: "alias_closed",
      actorId: input.userId,
      actorKind: "user",
    })
    .run();

  return { ok: true };
}
