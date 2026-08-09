import "server-only";

import { and, eq, lt, or, sql } from "drizzle-orm";

import type { CurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { messages } from "@/lib/db/schema";
import { dayScope } from "@/lib/forum/convert-source";
import {
  ARCHIVE_PAGE_SIZE,
  pageOfMessage,
  type MessageOrder,
} from "@/lib/messages/archive-rules";
import { assertGroupAccess } from "@/lib/queries/visibility";
import { dateKey } from "@/lib/time";

/**
 * 「这条消息在哪」—— 按消息 id 算出群、日期、页码。
 *
 * ─────────────────────────────────────────
 * 为什么需要它
 * ─────────────────────────────────────────
 *
 * 「谁 @ 了我」的通知原来只链到 `/archive?group=…&date=…`：
 * 落到那一天，然后自己在**几千条**里找那一条。那不叫定位。
 * 有了这个函数，链接只需要带消息 id，剩下的服务端算：
 * 哪个群、哪一天、当前排序下第几页 —— 页面直接把那一条渲染出来并高亮。
 *
 * ─────────────────────────────────────────
 * 这是一条新的取数路径，所以必须自己过隐私那道闸
 * ─────────────────────────────────────────
 *
 * 群消息属于隐私：只有群里的人看得见。一个「按 id 直达某条消息」的
 * 接口如果不校验查看者在不在那个群，等于把整个群的聊天记录
 * 变成可以按 id 遍历的公开接口 —— 而消息 id 是上游给的数字串，
 * 遍历成本极低。
 *
 * 所以这里走**现成的** `assertGroupAccess`，不另写一套判断。
 * 拿不到就返回 null，不区分「不存在」与「没权限」：
 * 区分开的话，这个接口就成了「某条消息是否存在」的探测器。
 */

export interface MessageLocation {
  convId: string;
  /** 东八区的 YYYY-MM-DD */
  date: string;
  /** 在当前排序下，这条消息落在第几页 */
  page: number;
  /**
   * 这条消息在页面上渲染得出来吗。
   *
   * 正文被存储裁剪掉的消息不进列表，锚点自然也就锚不住。
   * 这时仍然返回位置（人还能读到前后文），但页面不该假装高亮了什么。
   */
  anchored: boolean;
}

export function locateMessage(
  user: CurrentUser | null,
  messageId: string,
  options: { order: MessageOrder; perPage?: number },
): MessageLocation | null {
  const target = db
    .select({
      convId: messages.convId,
      ts: messages.ts,
      content: messages.content,
      isSend: messages.isSend,
    })
    .from(messages)
    .where(eq(messages.id, messageId))
    .get();
  if (!target) return null;

  // ← 隐私收口。这一行没了，这个函数就是个群聊导出接口
  if (!assertGroupAccess(user, target.convId)) return null;

  const date = dateKey(target.ts);
  const perPage = options.perPage ?? ARCHIVE_PAGE_SIZE;
  const scope = dayScope(target.convId, date);

  const total =
    db
      .select({ n: sql<number>`count(*)` })
      .from(messages)
      .where(scope)
      .get()?.n ?? 0;

  /*
   * 数出这一天里排在它前面的有多少条。
   *
   * 次级键用 id，和列表查询的 ORDER BY ts, id 完全一致 ——
   * 同一秒里有好几条时，不带次级键会算出一个「大概的」下标，
   * 而大概的下标在页边界上就是错的一页。
   */
  const indexAsc =
    db
      .select({ n: sql<number>`count(*)` })
      .from(messages)
      .where(
        and(
          scope,
          or(
            lt(messages.ts, target.ts),
            and(eq(messages.ts, target.ts), lt(messages.id, messageId)),
          ),
        ),
      )
      .get()?.n ?? 0;

  return {
    convId: target.convId,
    date,
    page: pageOfMessage({ indexAsc, total, order: options.order, perPage }),
    anchored: target.content !== "" && !target.isSend,
  };
}
