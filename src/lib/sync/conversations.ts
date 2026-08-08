import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { groups } from "@/lib/db/schema";
import { nekobot } from "@/lib/nekobot/client";

import { runSyncJob, type SyncOptions, type SyncResult } from "./job";

/**
 * 同步会话列表。
 *
 * 只把群写进 groups 表；私聊会话不落这张表 —— 它们只在绑定验证时按需查询上游，
 * 本站不保存任何私聊内容。
 *
 * **纳入统计的判据是上游的 bound 参数**：机器人真正绑定了的群，
 * 就是要接收和统计消息的群。新群一旦 bound，下一轮同步自动纳入，无需人工开关。
 * 唯一的例外是管理员显式排除（syncExcluded），那是唯一能压过上游的开关。
 */
export async function syncConversations(options: SyncOptions = {}): Promise<SyncResult> {
  return runSyncJob("conversations", options, async () => {
    const conversations = await nekobot.conversations({ groups_only: true, limit: 500 });

    let written = 0;
    db.transaction((tx) => {
      for (const conv of conversations) {
        tx.insert(groups)
          .values({
            convId: conv.conv_id,
            name: conv.name,
            isGroup: conv.is_group,
            bound: conv.bound,
            messageCount: conv.messages,
            lastMessageAt: conv.last_time,
            syncEnabled: conv.bound,
          })
          .onConflictDoUpdate({
            target: groups.convId,
            set: {
              name: conv.name,
              bound: conv.bound,
              messageCount: conv.messages,
              lastMessageAt: conv.last_time,
              // bound 变化要立即反映到是否纳入统计
              syncEnabled: sql`${conv.bound ? 1 : 0} AND NOT ${groups.syncExcluded}`,
              updatedAt: Date.now(),
            },
          })
          .run();
        written++;
      }
    });

    return { fetched: conversations.length, written };
  });
}
