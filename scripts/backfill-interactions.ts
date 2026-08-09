/**
 * 回填历史消息的 @提及 与回复关系。
 *
 *   npx tsx --conditions=react-server scripts/backfill-interactions.ts          全部群
 *   npx tsx --conditions=react-server scripts/backfill-interactions.ts <conv_id> 只回填一个群
 *
 * 可安全重跑：每条消息先删后插、reply_to_id 重算覆盖，
 * 结果只取决于当前的正文与名册（见 backfillConv）。
 * **不发通知** —— 回填 4 万条历史会把每个人的通知箱灌满一年前的 @。
 *
 * 昵称解析用的是**当前**名册（含改名事件里的曾用名）。
 * 名册之后又变了的话，重跑一次即可按新名册重解析 ——
 * 这正是把解析结果与字面昵称分开存的意义。
 */
import {
  backfillConv,
  convsWithMessages,
  type BackfillStats,
} from "@/lib/messages/interactions";

const only = process.argv[2];

function add(total: BackfillStats, s: BackfillStats) {
  total.scanned += s.scanned;
  total.replies += s.replies;
  total.mentionRows += s.mentionRows;
  total.resolved += s.resolved;
  total.ambiguous += s.ambiguous;
  total.unknown += s.unknown;
  total.all += s.all;
}

function main() {
  const convs = only ? [only] : convsWithMessages();
  const total: BackfillStats = {
    scanned: 0,
    replies: 0,
    mentionRows: 0,
    resolved: 0,
    ambiguous: 0,
    unknown: 0,
    all: 0,
  };

  for (const convId of convs) {
    const started = Date.now();
    const stats = backfillConv(convId);
    add(total, stats);
    console.log(
      `${convId}: 扫描 ${stats.scanned}，提及 ${stats.mentionRows}` +
        `（认出 ${stats.resolved} / 歧义 ${stats.ambiguous} / 未知 ${stats.unknown}` +
        ` / @所有人 ${stats.all}），回复目标 ${stats.replies}（${Date.now() - started}ms）`,
    );
  }

  console.log(
    `\n合计：扫描 ${total.scanned}，提及 ${total.mentionRows}` +
      `（认出 ${total.resolved} / 歧义 ${total.ambiguous} / 未知 ${total.unknown}` +
      ` / @所有人 ${total.all}），回复目标 ${total.replies}`,
  );
  if (total.replies === 0) {
    console.log(
      "回复目标为 0 是预期结果：上游 /v1/messages 目前不透传引用关系" +
        "（见 src/lib/messages/reply.ts），透传之后重跑本脚本即可回填。",
    );
  }
}

main();
