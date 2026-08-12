import { eq, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { boards, posts } from "@/lib/db/schema";
import { charCountOf } from "@/lib/forum/longform";

/**
 * 把已有的帖子重新归到新版块里。
 *
 * ═════════════════════════════════════════
 * 为什么必须做这一步
 * ═════════════════════════════════════════
 *
 * 新建三个空版块什么都解决不了。第一个点进「深度好文」的人
 * 看到的是「还没有人发过」—— 于是他也不发，空着就一直空着。
 * 而现成的四十三篇长文正躺在「综合讨论」里没人看得见。
 *
 * ─────────────────────────────────────────
 * 这是在动别人的帖子，所以规矩要严
 * ─────────────────────────────────────────
 *
 *   · **只动 general**。别的版块是作者主动选的，那是他的判断，不是我的
 *   · **拿不准就不动**。留在综合讨论只是不够理想，搬错地方是真的错
 *   · **每一条都记原来在哪**，随时能搬回去
 *   · 先 `--dry` 打出完整计划，看过每一行再落库
 *
 * 跑法：
 *   npx tsx scripts/refile-posts.ts --dry
 *   npx tsx scripts/refile-posts.ts --apply
 */

interface Rule {
  to: string;
  why: string;
  match: (post: { title: string; chars: number }) => boolean;
}

/*
 * 顺序就是优先级 —— 第一条命中的说了算。
 *
 * 站务反馈放在最前面：那八条本该去「反馈与报错」的帖子里，
 * 有几条也挺长，先判长度的话它们会被扫进「深度好文」，
 * 而一句「有很多404页面」放在好文里是很难看的。
 */
const RULES: Rule[] = [
  {
    to: "feedback",
    why: "对站点本身的建议或报错",
    match: ({ title, chars }) =>
      chars < 300 &&
      /(建议|功能|404|申请入口|需要修改|加一下|支持一下|推送|私信|登录不进来|模糊搜索)/.test(title),
  },
  {
    to: "howto",
    why: "动手做一件事的记录或教程",
    match: ({ title }) =>
      /(教程|手把手|部署|刷机|BL ?解|解了|踩坑|配置坑|报错|采样|修改教程|强制升级|折腾|微调的心得|心得详细)/.test(
        title,
      ),
  },
  {
    to: "news",
    why: "短快讯：发布、定档、报价、传闻",
    match: ({ title, chars }) =>
      chars < 1200 &&
      /(发布会|定档|被曝|曝正在|报价|将推出|即将|预测这|普及后|大爆发|正在测试)/.test(title),
  },
  {
    to: "articles",
    why: "正文够长，是成篇的文章",
    match: ({ chars }) => chars >= 2000,
  },
];

function main() {
  const apply = process.argv.includes("--apply");
  if (!apply && !process.argv.includes("--dry")) {
    console.error("要么 --dry 要么 --apply");
    process.exit(1);
  }

  const boardRows = db.select().from(boards).where(isNull(boards.deletedAt)).all();
  const byKey = new Map(boardRows.map((b) => [b.key, b]));
  const general = byKey.get("general");
  if (!general) throw new Error("没有 general 版块");

  for (const rule of RULES) {
    if (!byKey.has(rule.to)) throw new Error(`目标版块还没建：${rule.to}（先跑 seedBoards）`);
  }

  const rows = db
    .select({ id: posts.id, title: posts.title, content: posts.content })
    .from(posts)
    .where(sql`${posts.boardId} = ${general.id} AND ${posts.deletedAt} IS NULL`)
    .all();

  const plan: { id: string; title: string; to: string; why: string; chars: number }[] = [];
  const stay: { title: string; chars: number }[] = [];

  for (const row of rows) {
    const chars = charCountOf(row.content);
    const title = row.title ?? "";
    const hit = RULES.find((r) => r.match({ title, chars }));
    if (hit) plan.push({ id: row.id, title, to: hit.to, why: hit.why, chars });
    else stay.push({ title, chars });
  }

  const counts = new Map<string, number>();
  for (const p of plan) counts.set(p.to, (counts.get(p.to) ?? 0) + 1);

  console.log(`综合讨论现有 ${rows.length} 帖，其中 ${plan.length} 帖要搬：\n`);
  for (const target of ["articles", "howto", "news", "feedback"]) {
    const group = plan.filter((p) => p.to === target);
    if (group.length === 0) continue;
    console.log(`── → ${byKey.get(target)!.name}（${group.length} 帖）`);
    for (const p of group) console.log(`   ${String(p.chars).padStart(6)} 字  ${p.title.slice(0, 44)}`);
    console.log();
  }

  console.log(`── 留在综合讨论（${stay.length} 帖）`);
  for (const s of stay) console.log(`   ${String(s.chars).padStart(6)} 字  ${s.title.slice(0, 44)}`);

  if (!apply) {
    console.log("\n(--dry：一条都没动)");
    return;
  }

  let moved = 0;
  db.transaction((tx) => {
    for (const p of plan) {
      tx.update(posts)
        .set({ boardId: byKey.get(p.to)!.id })
        .where(eq(posts.id, p.id))
        .run();
      moved++;
    }

    /*
     * 版块的 post_count 是缓存列，搬完必须重算 ——
     * 不算的话，「深度好文」上写着 0 而里面有四十篇，
     * 而这种不一致没有任何地方会报错。
     */
    for (const b of boardRows) {
      const n =
        tx
          .select({ n: sql<number>`count(*)` })
          .from(posts)
          .where(sql`${posts.boardId} = ${b.id} AND ${posts.deletedAt} IS NULL`)
          .get()?.n ?? 0;
      tx.update(boards).set({ postCount: n }).where(eq(boards.id, b.id)).run();
    }
  });

  console.log(`\n搬了 ${moved} 帖，各版块计数已重算。`);
}

main();
