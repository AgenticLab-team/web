/**
 * 手工授予称号。
 *
 *   npm run grant-title -- seed_user jmr 另一个人 ...
 *   npm run grant-title -- seed_user --all-active      # 给所有已登录过的人
 *   npm run grant-title -- seed_user --dry-run jmr
 *
 * 内测这批人要发「种子用户」，一个个点后台太慢。
 * 但**默认打印将要发给谁再执行**，因为稀有称号有名额上限、
 * 发出去收不回（收回比不发更伤人）—— 批量操作最怕的就是发错人。
 */

import { and, eq, isNull, isNotNull } from "drizzle-orm";

import { db } from "@/lib/db";
import { titles, userTitles, users } from "@/lib/db/schema";
import { checkGrant, expiryFor, type TitleSpec } from "@/lib/titles/rules";
import { holderCount } from "@/lib/titles/queries";
import { resolveDisplayName } from "@/lib/users/display-name";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const all = args.includes("--all-active");
const positional = args.filter((a) => !a.startsWith("--"));
const [titleKey, ...names] = positional;

if (!titleKey) {
  console.error("用法：npm run grant-title -- <称号key> [--all-active|--dry-run] <昵称或wxid或id>...");
  process.exit(1);
}

const title = db.select().from(titles).where(eq(titles.key, titleKey)).get();
if (!title) {
  console.error(`找不到称号 ${titleKey}`);
  console.error("现有：", db.select({ k: titles.key }).from(titles).all().map((t) => t.k).join(", "));
  process.exit(1);
}

const spec: TitleSpec = {
  id: title.id,
  key: title.key,
  name: title.name,
  rarity: title.rarity,
  source: title.source,
  price: title.price,
  rentDays: title.rentDays,
  limitCount: title.limitCount,
  enabled: title.enabled,
};

const candidates = all
  ? db.select().from(users).where(and(isNull(users.deletedAt), isNotNull(users.lastActiveAt))).all()
  : names
      .map((needle) => {
        const rows = db.select().from(users).where(isNull(users.deletedAt)).all();
        return rows.find(
          (u) =>
            u.id === needle ||
            u.wxId === needle ||
            u.siteNickname === needle ||
            u.wxNickname === needle,
        );
      })
      .filter(Boolean) as (typeof users.$inferSelect)[];

if (!all) {
  for (const needle of names) {
    const found = candidates.some(
      (u) => u.id === needle || u.wxId === needle || u.siteNickname === needle || u.wxNickname === needle,
    );
    if (!found) console.warn(`⚠ 找不到「${needle}」，跳过`);
  }
}

if (candidates.length === 0) {
  console.error("没有匹配到任何人");
  process.exit(1);
}

console.log(`称号：${title.icon ?? ""} ${title.name}（${title.key}）`);
if (title.limitCount !== null) {
  console.log(`名额：${holderCount(title.id)} / ${title.limitCount}`);
}
console.log(`候选 ${candidates.length} 人：\n`);

let granted = 0;
let skipped = 0;

for (const user of candidates) {
  const label = resolveDisplayName([user.siteNickname, user.wxNickname], {
    wxId: user.wxId,
    fallback: user.id,
  });

  const already = db
    .select()
    .from(userTitles)
    .where(
      and(eq(userTitles.userId, user.id), eq(userTitles.titleId, title.id), isNull(userTitles.revokedAt)),
    )
    .get();

  // 名额要**每次重新数**：批量发放时前面几个已经占掉了名额
  const check = checkGrant({
    title: spec,
    currentHolders: holderCount(title.id),
    alreadyHeld: already !== undefined,
    reason: "内测参与者",
  });

  if (!check.ok) {
    console.log(`  ✗ ${label} —— ${check.error}`);
    skipped++;
    continue;
  }

  if (dryRun) {
    console.log(`  · ${label}（预演，未写入）`);
    granted++;
    continue;
  }

  db.insert(userTitles)
    .values({
      userId: user.id,
      titleId: title.id,
      source: title.source,
      grantReason: "内测参与者",
      expiresAt: expiryFor(spec, Date.now()),
    })
    .run();
  console.log(`  ✓ ${label}`);
  granted++;
}

console.log(`\n${dryRun ? "预演" : "完成"}：授予 ${granted} 人，跳过 ${skipped} 人`);
if (dryRun) console.log("去掉 --dry-run 真正执行");
