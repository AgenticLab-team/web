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
import { claimPending, collapseJobs, completeJob } from "@/lib/sync/queue";
import { deliverBroadcast, pendingBroadcasts } from "@/lib/broadcast/sender";

const keyword = process.argv[2];

/**
 * 先处理后台排队的手动触发。
 *
 * 没有这一步的话，后台的「立即同步」按钮就是个谎：排进去的 pending
 * 永远不会被执行，而且「有任务在跑就不能再触发」的判定会把 pending
 * 也算进去 —— 点一次之后所有触发都被永久挡住。
 */
async function drainQueue() {
  const claimed = claimPending();
  if (claimed.length === 0) return;

  const targets = collapseJobs(claimed);
  console.log(`→ 后台排队的任务：${claimed.length} 条，去重后 ${targets.size} 个目标`);

  for (const [key, jobs] of targets) {
    const [kind, scope] = key.split(":");
    try {
      let result = { fetched: 0, written: 0 };
      if (kind === "messages") {
        result = scope
          ? await syncGroupMessages(scope, { triggeredBy: "admin" })
          : await syncAllGroups({ triggeredBy: "admin" });
      } else if (kind === "conversations") {
        result = await syncConversations({ triggeredBy: "admin" });
      } else if (kind === "members") {
        result = await syncAllMembers({ triggeredBy: "admin" });
      } else if (kind === "avatars") {
        result = await syncPeople({ triggeredBy: "admin" });
      } else {
        // 认不出的 kind 要如实失败，不能悄悄标成成功
        for (const job of jobs) {
          completeJob(job.id, { fetched: 0, written: 0, error: `不支持的同步类型：${kind}` });
        }
        console.warn(`  ⚠ 不支持的同步类型：${kind}`);
        continue;
      }

      // 折叠掉的那几条也要一起收尾，否则它们会永远挂在 running
      for (const job of jobs) completeJob(job.id, result);
      console.log(`  ${key}：拉取 ${result.fetched}，新增 ${result.written}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const job of jobs) completeJob(job.id, { fetched: 0, written: 0, error: message });
      console.error(`  ✗ ${key}：${message}`);
    }
  }
}

/**
 * 把排队中的群发真正发出去。
 *
 * 和同步队列一样：**没有这一步的话，后台那个「发送」按钮是个谎**。
 * 上一轮就是这么栽的 —— 排进去的任务永远不会被执行。
 */
async function drainBroadcasts() {
  const ids = pendingBroadcasts();
  if (ids.length === 0) return;

  console.log(`→ 排队中的群发：${ids.length} 条`);
  for (const id of ids) {
    const report = await deliverBroadcast(id);
    if (report.error) {
      console.error(`  ✗ ${id}：${report.error}`);
    } else {
      console.log(
        `  ${id}：成功 ${report.sent}，失败 ${report.failed}，跳过 ${report.skipped}`,
      );
    }
  }
}

async function main() {
  await drainQueue();
  await drainBroadcasts();

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
