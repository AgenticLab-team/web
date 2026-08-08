/**
 * 群同步状态。
 *
 * 纳入统计的判据是**上游的 bound 参数** —— 机器人真正绑定了的群自动纳入，
 * 不需要人工开启。这里的 exclude 是唯一能压过上游的管理员开关。
 *
 *   npm run groups                     列出所有群
 *   npm run groups -- exclude <关键词>  排除某个 bound 群（不再接收统计）
 *   npm run groups -- include <关键词>  取消排除
 */
import { eq, like } from "drizzle-orm";

import { db } from "@/lib/db";
import { groups } from "@/lib/db/schema";

const [action, keyword] = process.argv.slice(2);

function list() {
  const rows = db.select().from(groups).all();
  rows.sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
  console.log(["bound", "统计", "排除", "成员".padStart(5), "消息数".padStart(7), "群名"].join("  "));
  for (const g of rows) {
    console.log(
      [
        g.bound ? "  ✓  " : "  ·  ",
        g.syncEnabled ? " ✓  " : " ·  ",
        g.syncExcluded ? " ✗  " : "    ",
        String(g.memberCount).padStart(5),
        String(g.messageCount).padStart(7),
        g.name,
      ].join("  "),
    );
  }
  console.log(
    `\n共 ${rows.length} 个群 · bound ${rows.filter((g) => g.bound).length} 个 · 纳入统计 ${rows.filter((g) => g.syncEnabled).length} 个`,
  );
}

function setExcluded(excluded: boolean, kw: string) {
  const matched = db.select().from(groups).where(like(groups.name, `%${kw}%`)).all();
  if (matched.length === 0) {
    console.log(`没有匹配「${kw}」的群`);
    return;
  }
  for (const g of matched) {
    db.update(groups)
      .set({
        syncExcluded: excluded,
        // 排除立即生效；取消排除后是否统计仍由 bound 决定
        syncEnabled: excluded ? false : g.bound,
        updatedAt: Date.now(),
      })
      .where(eq(groups.convId, g.convId))
      .run();
    console.log(`${excluded ? "已排除" : "已恢复"}：${g.name}`);
  }
}

if (action === "exclude" && keyword) setExcluded(true, keyword);
else if (action === "include" && keyword) setExcluded(false, keyword);
else list();
