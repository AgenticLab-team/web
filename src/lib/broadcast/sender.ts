import "server-only";

import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { isModuleEnabled } from "@/lib/modules/state";
import { broadcastDeliveries, broadcasts } from "@/lib/db/schema";
import { contentHash, sendIntervalMs } from "@/lib/broadcast/rules";
import { NekoBotError, nekobot } from "@/lib/nekobot/client";
import { sendFailed } from "@/lib/nekobot/types";

/**
 * 真正把消息发出去的地方。由后台进程调用，不在 web 请求里跑。
 *
 * 一次群发要给十二个群逐条发、每条之间还要留间隔，整体一两分钟 ——
 * 放在 web 请求里，超时会把它拦腰截断，而那时一部分群已经收到了。
 * 「发了一半」是最糟的状态：一部分人收到，一部分没有，
 * 而重发会让前一部分人收到两遍。
 *
 * 所以这里有三条：
 *   ① 逐条留痕，发一条记一条 —— 中途崩溃也知道发到哪了
 *   ② 已经发成功的不再重发（靠 delivery 状态，不是靠内存里的下标）
 *   ③ 发之前**再校验一次内容哈希** —— 复核之后到真正发出去之间
 *      还有一段时间，那段时间里内容不能被改
 */

export interface SendReport {
  broadcastId: string;
  sent: number;
  failed: number;
  skipped: number;
  error?: string;
}

/** 取出所有排队中的群发。返回 id 列表，逐个执行 */
export function pendingBroadcasts(): string[] {
  return db
    .select({ id: broadcasts.id })
    .from(broadcasts)
    .where(and(eq(broadcasts.channel, "wechat"), eq(broadcasts.status, "sending")))
    .all()
    .map((r) => r.id);
}

export async function deliverBroadcast(
  broadcastId: string,
  options: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<SendReport> {
  // 关掉之后一律不发，包括已经排好的 —— 群发是唯一会打扰到群里所有人的动作
  if (!isModuleEnabled("broadcast")) {
    return {
      broadcastId,
      sent: 0,
      failed: 0,
      skipped: 0,
      error: "群发模块已关闭 —— 排队中的也不会发出去",
    };
  }

  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const row = db.select().from(broadcasts).where(eq(broadcasts.id, broadcastId)).get();
  if (!row) return { broadcastId, sent: 0, failed: 0, skipped: 0, error: "找不到这条群发" };

  /*
   * 发之前再校验一次内容哈希。
   * 复核通过到真正发出去之间还有一段时间 —— 那段时间里内容被改过的话，
   * 发出去的就不是被批准的那份了。这是最后一道闸，绝不能省。
   */
  if (row.contentHash !== contentHash(row.content)) {
    const error = "内容与复核时不一致，已中止发送";
    db.update(broadcasts)
      .set({ status: "failed", error, finishedAt: Date.now() })
      .where(eq(broadcasts.id, broadcastId))
      .run();
    return { broadcastId, sent: 0, failed: 0, skipped: 0, error };
  }

  let quota;
  try {
    quota = await nekobot.sendQuota();
  } catch (error) {
    // 查不到额度就不发。「查不到就当没限制」正是撞上风控的姿势
    const message = `查不到上游额度：${error instanceof Error ? error.message : String(error)}`;
    db.update(broadcasts)
      .set({ status: "failed", error: message, finishedAt: Date.now() })
      .where(eq(broadcasts.id, broadcastId))
      .run();
    return { broadcastId, sent: 0, failed: 0, skipped: 0, error: message };
  }

  const gap = sendIntervalMs(quota.per_minute.limit);

  const deliveries = db
    .select()
    .from(broadcastDeliveries)
    .where(eq(broadcastDeliveries.broadcastId, broadcastId))
    .all();

  /*
   * **一条待发记录都没有 = 出错了，不是发完了。**
   *
   * 原来这里直接往下走：循环零次，最后把广播标成 `sent` ——
   * 于是一条发给零个群的广播，在状态、返回值和日志三处都说自己成功了。
   *
   * 这不是假想：日报那条路第一版忘了建逐群记录，试发之后群里什么都没有，
   * 而后台显示「已发送」。查了三层才找到，因为**没有任何一处是红的**。
   */
  if (deliveries.length === 0) {
    const error = "没有任何待发记录 —— 这条广播没有目标群，不是发完了";
    db.update(broadcasts)
      .set({ status: "failed", error, finishedAt: Date.now() })
      .where(eq(broadcasts.id, broadcastId))
      .run();
    return { broadcastId, sent: 0, failed: 0, skipped: 0, error };
  }

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const [index, delivery] of deliveries.entries()) {
    // 已经发过的不再重发 —— 靠数据库状态判断，不是靠内存里的下标
    if (delivery.status !== "pending") {
      skipped++;
      continue;
    }

    if (index > 0) await sleep(gap);

    try {
      const result = await nekobot.sendText(delivery.convId, row.content);

      /*
       * **先看 `ok`**：上游发失败时会回 200 加 `{"ok": false}`，
       * 而 `request()` 只在非 2xx 时抛错 —— 不看的话这一条会被记成
       * 「已发送」，计数说成功、界面说送达，而群里什么都没出现。
       */
      const rejected = sendFailed(result);
      if (rejected) throw new NekoBotError(rejected, "http");

      /*
       * msg_svr_id 拿不到时仍然算发送成功 —— 消息确实发出去了 ——
       * 但要记下来「撤不回」。当成失败会导致重发，那更糟。
       */
      db.update(broadcastDeliveries)
        .set({
          status: "sent",
          msgSvrId: result.msg_svr_id ?? null,
          sentAt: Date.now(),
          error: result.msg_svr_id ? null : "上游没有返回消息 id，这一条撤不回来",
        })
        .where(eq(broadcastDeliveries.id, delivery.id))
        .run();
      sent++;
    } catch (error) {
      db.update(broadcastDeliveries)
        .set({
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        })
        .where(eq(broadcastDeliveries.id, delivery.id))
        .run();
      failed++;
    }

    // 每发一条就更新一次计数，中途崩溃也知道发到哪了
    db.update(broadcasts)
      .set({ sentCount: sent, failedCount: failed })
      .where(eq(broadcasts.id, broadcastId))
      .run();
  }

  db.update(broadcasts)
    .set({
      status: failed > 0 && sent === 0 ? "failed" : "sent",
      finishedAt: Date.now(),
      sentCount: sent,
      failedCount: failed,
      error: failed > 0 ? `${failed} 个群发送失败` : null,
    })
    .where(eq(broadcasts.id, broadcastId))
    .run();

  return { broadcastId, sent, failed, skipped };
}
