/**
 * 重算所有版块的帖子计数。
 *
 * boards.post_count 历史上只在网页发帖时 +1，群聊转帖不加、删帖不减，
 * 线上「群聊沉淀」版因此一直显示 0（实际有帖子）。
 * 写路径现已统一改为从 posts 表重算（见 src/lib/forum/board-stats.ts），
 * 这个脚本负责把历史漂移一次性纠正；之后任何时候重跑都应显示全部无变化，
 * 若有变化说明又有写路径漏掉了重算，要回去查代码。
 *
 *   npm run recount-boards
 */
import { recountAllBoards } from "@/lib/forum/board-stats";

function main() {
  const rows = recountAllBoards();
  let drifted = 0;
  for (const row of rows) {
    const changed = row.before !== row.after;
    if (changed) drifted++;
    console.log(
      `${row.key.padEnd(12)} ${String(row.before).padStart(4)} ${changed ? "→" : " "} ${String(row.after).padStart(4)}  ${row.name}`,
    );
  }
  console.log(drifted === 0 ? "完成：无漂移" : `完成：修正了 ${drifted} 个版块`);
}

main();
