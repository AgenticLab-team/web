import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { dailyStats } from "@/lib/db/schema";
import { resolveBotWxId } from "@/lib/stats/bot-identity";

/**
 * 把机器人已经攒下的统计行清掉。
 *
 * ─────────────────────────────────────────
 * 为什么需要单独跑一次
 * ─────────────────────────────────────────
 *
 * 新口径（见 lib/stats/authorship.ts）只在**重算**时生效，
 * 而重算只发生在「这一轮碰过的人 × 天」上 —— 机器人从此不再进入
 * 那个集合，所以它已有的一千五百多行**永远不会被重算掉**。
 *
 * 它们会一直挂在榜上，而代码看起来完全正确。
 *
 * 删是安全的：daily_stats 完全可以从 messages 推导出来
 * （采集那一侧的注释里写着这一点，重算逻辑也依赖它）。
 * 万一哪天要把机器人放回榜上，重算一遍就回来了。
 *
 *   npx tsx --conditions=react-server --env-file=.env.local scripts/purge-bot-stats.ts --dry
 *   npx tsx --conditions=react-server --env-file=.env.local scripts/purge-bot-stats.ts --apply
 */
async function main() {
  const apply = process.argv.includes("--apply");
  if (!apply && !process.argv.includes("--dry")) {
    console.error("要么 --dry 要么 --apply");
    process.exit(1);
  }

  const botWxId = await resolveBotWxId();
  if (!botWxId) {
    // 取不到就什么都不做 —— 猜一个的后果是删掉一个真人的全部统计
    console.error("拿不到机器人身份（上游 /binding 不通），什么都没做");
    process.exit(1);
  }

  const rows = db.select().from(dailyStats).where(eq(dailyStats.wxId, botWxId)).all();
  const messages = rows.reduce((sum, r) => sum + (r.messages ?? 0), 0);
  console.log(`机器人 ${botWxId}：${rows.length} 行、合计 ${messages} 条消息`);

  if (!apply) {
    console.log("(--dry：一行都没删)");
    return;
  }

  const result = db.delete(dailyStats).where(eq(dailyStats.wxId, botWxId)).run();
  console.log(`删了 ${result.changes} 行。它不会再回来 —— 新口径下它进不了重算的集合。`);
}

main();
