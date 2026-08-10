/**
 * 资源库回填。
 *
 *   npm run links              回填全部历史消息里的链接
 *   npm run links -- --audit   只对账，不写入
 *   npm run links -- --retitle 按当前规则重算标题（改了抽取规则之后跑）
 *   npm run links -- --github  给 GitHub 链接问出权威标题与简介
 *                              加 --force 连问过的一起重问（改了展示规则之后跑）
 *
 * 可以反复跑：唯一索引挡住重复的 mention，计数每次从明细现算。
 * 不幂等的话，跑六遍会让「被分享 64 次」这种数字凭空冒出来，
 * 而没有任何地方能看出它是假的。
 */
import { lookupGithubLinks } from "@/lib/github/link-lookup";
import { fillRecentMentions } from "@/lib/github/mentions";
import { auditLinkCounts, backfillLinks, retitleAll } from "@/lib/links/ingest";
import { linkStats } from "@/lib/links/queries";

/**
 * 给 GitHub 链接问出「这是什么」。
 *
 * 单独一个开关而不是并进回填：回填是纯本地的、跑多少遍都行，
 * 而这一步**要打外网、有配额**（不配 `GITHUB_API_TOKEN` 时
 * 按服务器 IP 每小时只有 60 次）。混在一起的话，
 * 一次例行回填会顺手把配额烧掉。
 */
async function github(limit: number, force: boolean) {
  const r = await lookupGithubLinks({ limit, force });
  console.log(
    `资源库：扫描 ${r.scanned} 条 GitHub 链接 · 问到 ${r.written} · 已不存在 ${r.gone} · 失败 ${r.failed}`,
  );
  for (const note of r.notes.slice(0, 10)) console.log(`  ${note}`);
  if (r.failed > 0) console.log("  （失败的没记时间戳，下次还会再问）");

  /*
   * 顺带把论坛帖子里提到的也补上 —— 两边共用同一份 GitHub 配额
   * （同一个出口 IP），分成两个定时任务只会让它们互相抢。
   *
   * 资源库那一步排在前面：它是**列表页上直接显示的标题**，
   * 空着就是一行裸域名；帖子那边缺了只是少一张补充卡片，正文照旧完整。
   */
  const m = await fillRecentMentions();
  console.log(
    `帖子提到的：问了 ${m.asked} 个 · 写入 ${m.written} · 已不存在 ${m.gone} · 失败 ${m.failed}`,
  );
  for (const note of m.notes.slice(0, 10)) console.log(`  ${note}`);
}

async function main() {
  if (process.argv.includes("--github")) {
    const at = process.argv.indexOf("--limit");
    const limit = at >= 0 ? Number(process.argv[at + 1]) : 30;
    await github(
      Number.isSafeInteger(limit) && limit > 0 ? limit : 30,
      process.argv.includes("--force"),
    );
    return;
  }

  if (process.argv.includes("--audit")) {
    const drift = auditLinkCounts();
    console.log(drift.length === 0 ? "✓ 分享次数与明细对得上" : `✗ ${drift.length} 条对不上`);
    for (const row of drift.slice(0, 10)) {
      console.log(`  ${row.linkId}  记 ${row.stored}  实际 ${row.actual}`);
    }
    process.exit(drift.length === 0 ? 0 : 1);
  }

  if (process.argv.includes("--retitle")) {
    // 标题是存下来的：改了规则不重算，线上还是旧样子
    console.log(`✓ 重算标题：${retitleAll()} 条有变化`);
    return;
  }

  const result = backfillLinks();
  console.log(
    `扫描 ${result.scanned} 条带链接的消息 · 新增链接 ${result.created} · 新增分享记录 ${result.mentions} · 跳过 ${result.skipped}`,
  );

  const stats = linkStats();
  console.log(`资源库现有 ${stats.total} 条（隐藏 ${stats.hidden}）· ${stats.domains} 个域名`);

  const drift = auditLinkCounts();
  if (drift.length > 0) console.log(`⚠ ${drift.length} 条的分享次数与明细对不上`);
}

void main();
