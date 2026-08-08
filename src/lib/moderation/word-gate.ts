import "server-only";

import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { reports, sensitiveWords } from "@/lib/db/schema";
import { scanText, type ScanResult, type WordRule } from "@/lib/moderation/words";

/**
 * 敏感词闸门。发帖与回帖都走这一份。
 *
 * 两个刻意的决定：
 *
 * ① **拦截时不回显命中了哪个词。**
 *   回显等于把词库白送给想绕过的人：改一个字再试，几次就摸清了。
 *   但也不能只说「内容不合规」然后一走了之 —— 那是最招怨的做法。
 *   所以给的是「这条内容需要人工确认」+ 一个能申诉的去处。
 *
 * ② **送审档照常发布，只是进队列。**
 *   先扣下再审的话，误伤一次就是有人的内容凭空消失几小时，
 *   而子串匹配的误伤率注定不低。
 */

export interface GateResult {
  /** 能不能发 */
  allowed: boolean;
  /** 给用户看的话。拦截时不含具体词条 */
  message?: string;
  /** 替换之后的正文 */
  content: string;
  /** 需要进审核队列 */
  needsReview: boolean;
  scan: ScanResult;
}

function loadRules(): WordRule[] {
  return db
    .select()
    .from(sensitiveWords)
    .where(eq(sensitiveWords.enabled, true))
    .all()
    .map((row) => ({
      id: row.id,
      word: row.word,
      kind: row.kind,
      replacement: row.replacement,
      enabled: row.enabled,
    }));
}

export function checkContent(text: string): GateResult {
  const scan = scanText(text, loadRules());

  // 命中次数用来发现误伤：命中特别多的规则大概率是配错了
  bumpHitCounts(scan);

  if (scan.verdict === "block") {
    return {
      allowed: false,
      // 不说是哪个词。说了等于把词库交出去，改一个字再试几次就摸清了
      message: "这条内容需要人工确认后才能发布，请联系管理员或稍后再试",
      content: text,
      needsReview: false,
      scan,
    };
  }

  return {
    allowed: true,
    content: scan.replaced,
    needsReview: scan.verdict === "review",
    scan,
  };
}

/**
 * 送审：内容照常发布，同时生成一条举报进队列。
 *
 * 复用举报队列而不是再做一套：版主只需要盯一个地方，
 * 而且「系统自动送审」和「有人举报」本来就该按同样的流程处理。
 */
export function fileForReview(input: {
  targetType: "post" | "reply";
  targetId: string;
  targetUserId: string;
  scan: ScanResult;
}) {
  const words = [...new Set(input.scan.triggeredBy.map((h) => h.word))];
  if (words.length === 0) return;

  db.insert(reports)
    .values({
      // 系统送审也要有个举报人，用固定 id 便于在队列里区分
      reporterId: SYSTEM_REPORTER_ID,
      targetType: input.targetType,
      targetId: input.targetId,
      targetUserId: input.targetUserId,
      reasonCode: "other",
      detail: `自动送审：命中「${words.join("」「")}」`,
      // 自动送审是提示不是判决，按普通优先级排队
      severity: 0,
    })
    .onConflictDoNothing()
    .run();
}

export const SYSTEM_REPORTER_ID = "system:words";

function bumpHitCounts(scan: ScanResult) {
  const ids = [...new Set(scan.hits.map((h) => h.ruleId))];
  for (const id of ids) {
    db.update(sensitiveWords)
      .set({ hitCount: sql`${sensitiveWords.hitCount} + 1` })
      .where(eq(sensitiveWords.id, id))
      .run();
  }
}
