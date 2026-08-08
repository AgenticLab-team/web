/**
 * 初始化数据库：跑迁移 → 建 FTS → 灌种子 → 拉取群列表。
 * 幂等，可反复执行。
 *
 *   npx tsx scripts/bootstrap.ts
 */
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import { db } from "@/lib/db";
import { seedDatabase } from "@/lib/db/seed";
import { syncConversations } from "@/lib/sync/conversations";

async function main() {
  console.log("→ 执行迁移");
  migrate(db, { migrationsFolder: "./drizzle" });

  console.log("→ 灌入种子数据");
  const seed = seedDatabase();
  console.log(
    `  权限点 ${seed.permissions} · 新建角色 ${seed.roles} · 角色权限 ${seed.rolePermissions} · 新增配置 ${seed.settings} · 新增开关 ${seed.flags}`,
  );

  console.log("→ 同步群列表");
  try {
    const result = await syncConversations({ triggeredBy: "boot" });
    console.log(`  会话 ${result.fetched} 条，写入 ${result.written} 条`);
  } catch (err) {
    console.warn(`  跳过：上游不可用（${err instanceof Error ? err.message : String(err)}）`);
  }

  console.log("完成");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
