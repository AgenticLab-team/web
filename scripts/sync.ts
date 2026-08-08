/**
 * 手动跑一轮同步。
 *
 *   npm run sync              同步所有已开启的群
 *   npm run sync -- <关键词>   只同步匹配的群
 */
import { eq, like } from "drizzle-orm";

import { db } from "@/lib/db";
import { groups } from "@/lib/db/schema";
import { syncConversations } from "@/lib/sync/conversations";
import { syncPeople } from "@/lib/sync/people";
import { syncAllMembers } from "@/lib/sync/members";
import { syncAllGroups, syncGroupMessages } from "@/lib/sync/messages";

const keyword = process.argv[2];

async function main() {
  console.log("→ 刷新群列表");
  const convs = await syncConversations({ triggeredBy: "admin" });
  console.log(`  ${convs.written} 个群`);

  if (keyword) {
    const matched = db.select().from(groups).where(like(groups.name, `%${keyword}%`)).all();
    for (const g of matched) {
      if (!g.syncEnabled) {
        console.log(`  跳过（未开启同步）：${g.name}`);
        continue;
      }
      const started = Date.now();
      const result = await syncGroupMessages(g.convId, { triggeredBy: "admin" });
      console.log(
        `  ${g.name}：拉取 ${result.fetched}，新增 ${result.written}（${Date.now() - started}ms）`,
      );
    }
  } else {
    const enabled = db.select().from(groups).where(eq(groups.syncEnabled, true)).all();
    console.log(`→ 同步 ${enabled.length} 个群的消息`);
    const started = Date.now();
    const result = await syncAllGroups({ triggeredBy: "admin" });
    console.log(
      `  拉取 ${result.fetched}，新增 ${result.written}（${((Date.now() - started) / 1000).toFixed(1)}s）`,
    );
    if (result.note) console.warn(`  ⚠ ${result.note}`);

    console.log("→ 同步群成员名册");
    const members = await syncAllMembers({ triggeredBy: "admin" });
    console.log(`  ${members.written} 名成员`);
    if (members.note) console.warn(`  ⚠ ${members.note}`);

    // 昵称会变，本地源每轮都要跟着刷新
    console.log("→ 刷新人员名录");
    const ppl = await syncPeople({ triggeredBy: "admin" });
    console.log(`  ${ppl.fetched} 人，${ppl.note ?? ""}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
