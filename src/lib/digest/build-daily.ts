import "server-only";

import { and, eq, gte, ne } from "drizzle-orm";

import { contentHash } from "@/lib/broadcast/rules";
import { db } from "@/lib/db";
import { broadcasts, digestRuns, posts, users } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { isModuleEnabled } from "@/lib/modules/state";
import { dateKey } from "@/lib/time";
import { resolveDisplayName } from "@/lib/users/display-name";

import {
  DAILY_LOOKBACK_DAYS,
  renderDaily,
  selectDaily,
  shouldSendDaily,
} from "./daily";
import type { DigestCandidate } from "./weekly";

/**
 * 每天晚上那一条：备好并**直接排进发送队列**。
 *
 * ═════════════════════════════════════════
 * 它绕过了双人复核，这件事要说清楚
 * ═════════════════════════════════════════
 *
 * `broadcasts` 上有一条刻意的约束：复核人必须和创建人不是同一个人。
 * 周报因此只生成草稿，发不发由人按 —— 那条注释写着理由：
 * 「一个每周自动向一千六百人广播的机器人，被风控只是时间问题，
 * 而且没有人会为一条没人看过的自动消息负责」。
 *
 * 站长要的是每天 20:00 自动发，所以这条路上没有人按。
 * 换来的是三道能替代那个人的闸：
 *
 *   ① **内容面收得极窄**：只可能是站内已发布、且所有群成员都能看的帖子，
 *      标题和摘要都是作者自己写的。它不可能说出任何一句没人写过的话。
 *   ② **没内容就不发**（`shouldSendDaily`）。一条空的日报比不发更糟。
 *   ③ **独立开关** `digest_daily`：出问题时后台一键停掉，
 *      不牵连周报，也不牵连别的群发。
 *
 * 这三条替代不了「有人看过」，但它们把「自动消息能说出什么」
 * 压缩到了一个可以事先想清楚的集合里 —— 而那是自动化唯一站得住的形态。
 */

export interface DailyResult {
  date: string;
  ok: boolean;
  reason: string;
  broadcastId?: string;
  itemCount: number;
}

/** 已经推送过的帖子 —— **日报周报共用**，见 schema 里那段 */
function alreadySent(): Set<string> {
  const rows = db.select({ postIds: digestRuns.postIds }).from(digestRuns).all();
  const seen = new Set<string>();
  for (const row of rows) for (const id of (row.postIds as string[] | null) ?? []) seen.add(id);
  return seen;
}

function candidates(now: number): DigestCandidate[] {
  const since = now - DAILY_LOOKBACK_DAYS * 86_400_000;

  return db
    .select({
      id: posts.id,
      title: posts.title,
      excerpt: posts.excerpt,
      visibility: posts.visibility,
      status: posts.status,
      featured: posts.featured,
      replyCount: posts.replyCount,
      reactionCount: posts.reactionCount,
      viewCount: posts.viewCount,
      createdAt: posts.createdAt,
      authorId: posts.authorId,
      anonymous: posts.anonymous,
      siteNickname: users.siteNickname,
      wxNickname: users.wxNickname,
      wxId: users.wxId,
    })
    .from(posts)
    .leftJoin(users, eq(users.id, posts.authorId))
    .where(
      and(
        gte(posts.createdAt, since),
        eq(posts.status, "published"),
        ne(posts.type, "poll"),
      ),
    )
    .all()
    .map((r) => ({
      id: r.id,
      title: r.title,
      excerpt: r.excerpt,
      visibility: r.visibility,
      status: r.status,
      featured: r.featured,
      replyCount: r.replyCount ?? 0,
      reactionCount: r.reactionCount ?? 0,
      viewCount: r.viewCount ?? 0,
      createdAt: r.createdAt,
      authorId: r.authorId,
      // 和周报同一条口径：可见性是 group 的就是群聊转帖
      fromGroupChat: r.visibility === "group",
      /*
       * 匿名帖不署名。
       *
       * 它照样可以进日报（内容是公开的），但那条消息里不能出现作者 ——
       * 一条发进所有群的消息把匿名帖和某个名字连起来，
       * 匿名当场作废。
       */
      authorName: r.anonymous
        ? "匿名"
        : resolveDisplayName([r.siteNickname, r.wxNickname], {
            wxId: r.wxId,
            fallback: "成员",
          }),
    }));
}

export function buildDailyDigest(options: { now?: number; force?: boolean } = {}): DailyResult {
  const now = options.now ?? Date.now();
  const date = dateKey(now);

  /*
   * 独立开关，不复用 `digest`。
   *
   * 复用的话，站长想停掉「每天自动发」就必须连周报一起停 ——
   * 而周报是只生成草稿的，本来就没有需要停的理由。
   * 一个开关管两件危险程度差一个量级的事，最后一定是没人敢动它。
   */
  if (!isModuleEnabled("digest_daily")) {
    return { date, ok: false, reason: "每日推送这个模块没有启用", itemCount: 0 };
  }
  // 群发关掉时也不发 —— 排进队列也没人送，那不如不排
  if (!isModuleEnabled("broadcast")) {
    return { date, ok: false, reason: "群发模块关着，排了也送不出去", itemCount: 0 };
  }

  const existing = db
    .select()
    .from(digestRuns)
    .where(and(eq(digestRuns.kind, "daily"), eq(digestRuns.weekStart, date)))
    .get();

  if (existing && !options.force) {
    return {
      date,
      ok: false,
      reason: existing.broadcastId ? `今天已经发过了（${existing.broadcastId}）` : `今天判定为不发：${existing.skipReason}`,
      broadcastId: existing.broadcastId ?? undefined,
      itemCount: existing.itemCount,
    };
  }

  const selection = selectDaily(candidates(now), alreadySent());
  const verdict = shouldSendDaily(selection);

  const record = (postIds: string[], broadcastId: string | null, skipReason: string | null) =>
    db
      .insert(digestRuns)
      .values({
        kind: "daily",
        weekStart: date,
        postIds,
        itemCount: postIds.length,
        broadcastId,
        skipReason,
      })
      .onConflictDoUpdate({
        target: [digestRuns.kind, digestRuns.weekStart],
        set: { postIds, itemCount: postIds.length, broadcastId, skipReason },
      })
      .run();

  if (!verdict.send) {
    // 不发也留一行 —— 「今天怎么没有」要答得上来
    record([], null, verdict.reason);
    return { date, ok: false, reason: verdict.reason, itemCount: 0 };
  }

  const content = renderDaily(selection.items, {
    siteUrl: env.site.url,
    dateLabel: dayLabel(date),
  });

  const broadcast = db
    .insert(broadcasts)
    .values({
      channel: "wechat",
      title: `${dayLabel(date)} 今天值得读的`,
      content,
      contentHash: contentHash(content),
      // 留空 = 所有已接入的群。内容只含所有成员都能看的帖子，所以一份就够
      targetConvIds: null,
      /*
       * 直接 `sending`，不走 draft → pending → approved。
       *
       * 这是这个文件唯一一处「和周报不一样」的地方，理由在文件顶上。
       * 写成 `approved` 再等人推一把是自欺欺人 —— 那个人不存在，
       * 消息会堆在队列里，而站长以为它每天在发。
       */
      status: "sending",
      createdBy: SYSTEM_ACTOR,
    })
    .returning({ id: broadcasts.id })
    .get();

  record(
    selection.items.map((i) => i.id),
    broadcast.id,
    null,
  );

  return {
    date,
    ok: true,
    reason: verdict.reason,
    broadcastId: broadcast.id,
    itemCount: selection.items.length,
  };
}

/** 2026-08-13 → 「8 月 13 日」 */
export function dayLabel(date: string): string {
  const [, month, day] = date.split("-");
  return `${Number(month)} 月 ${Number(day)} 日`;
}

/** 和周报同一个系统作者，审计里看得出是机器生成的 */
const SYSTEM_ACTOR = "system";
