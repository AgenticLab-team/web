import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { repoRoot, stripComments } from "./_source";

/**
 * 导出了、却没有任何人调用的函数。
 *
 * ─────────────────────────────────────────
 * 这条测试是被我自己反复犯的一个错逼出来的
 * ─────────────────────────────────────────
 *
 * 做一个功能时顺手把「这个数据将来可能有人要」也实现掉 ——
 * 然后它就一直躺在那儿。**连着四次**：`hadAccountBefore`、
 * `departureCount`，还有另外两个。
 *
 * 危害不在于多几行代码，而在于**它读起来像有人在守着**：
 * 下一个人看到 `export function hadAccountBefore`，会以为
 * 「注销重绑」这件事已经有人处理了。实际什么都没守。
 *
 * 全仓扫下来这不是我一个人的习惯 —— 一次性清掉了 28 个。
 *
 * ─────────────────────────────────────────
 * 三档，只有第一档是硬规矩
 * ─────────────────────────────────────────
 *
 * ① **一个引用都没有** —— 连测试都不碰。没有任何辩护余地，必须是 0。
 * ② **只有测试在用** —— 这一档**不全是错的**：这个仓库刻意把一批
 *    纯规则函数单独拆出来「为了能被测试直接引用，不必拖进数据库依赖」
 *    （lib/quality.ts 的原话）。但它也正是我犯错的那一档，
 *    所以钉一份清单：新增一个就得动这张表，也就要有人过一眼
 *    「这条规则在生产里到底跑不跑」。
 * ③ 只在本文件里用却导出了 —— 最轻，不管。
 */

const LIB = join(repoRoot, "src/lib");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

const libFiles = walk(LIB);
const prodFiles = [...walk(join(repoRoot, "src")), ...walk(join(repoRoot, "scripts"))];
const testFiles = walk(join(repoRoot, "tests"));
const body = new Map(
  [...prodFiles, ...testFiles].map((f) => [f, stripComments(readFileSync(f, "utf8"))]),
);

interface Found {
  file: string;
  name: string;
  selfUses: number;
  testUses: number;
}

function scan(): Found[] {
  const out: Found[] = [];
  for (const file of libFiles) {
    const raw = readFileSync(file, "utf8");
    /*
     * `"use server"` 的文件跳过 —— 那里的导出是**跨进程边界**被调用的，
     * 客户端组件里的调用长得像普通 import，但构建之后是一次网络请求。
     * 按引用计数判会把它们全部误报成死的。
     */
    if (raw.startsWith('"use server"')) continue;
    const src = body.get(file)!;

    for (const m of raw.matchAll(/^export (?:async )?function (\w+)/gm)) {
      const name = m[1];
      const re = new RegExp(`\\b${name}\\b`, "g");
      const selfUses = (src.match(re) ?? []).length - 1;

      let prodUses = 0;
      for (const f of prodFiles) {
        if (f === file) continue;
        if (re.test(body.get(f)!)) prodUses++;
        re.lastIndex = 0;
      }
      if (prodUses > 0) continue;

      let testUses = 0;
      for (const f of testFiles) {
        if (re.test(body.get(f)!)) testUses++;
        re.lastIndex = 0;
      }
      /*
       * repoRoot 自带结尾斜杠，所以这里是 +4（"src/"）而不是 +5 ——
       * 多切一位的表现是清单里全是 "ib/..."，而它照样能通过
       * 「和自己比」的断言，只有和外部生成的清单一比才看得出来。
       */
      out.push({ file: file.slice(repoRoot.length + 4), name, selfUses, testUses });
    }
  }
  return out;
}

const found = scan();

describe("扫描本身没坏", () => {
  it("**真的扫到了一批导出** —— 正则退化的话下面每一条都会假绿", () => {
    let total = 0;
    for (const f of libFiles) {
      total += (readFileSync(f, "utf8").match(/^export (?:async )?function /gm) ?? []).length;
    }
    assert.ok(total > 300, `只认出 ${total} 个导出函数，解析八成退化了`);
  });
});

describe("**一个引用都没有的导出：必须是 0**", () => {
  it("没有任何地方（含测试）用得到的导出函数", () => {
    /*
     * 这一档没有辩护余地。要么有人用，要么删掉 ——
     * 「以后会用到」的那一份，真需要时重写也就几行，
     * 而留着的代价是它一直在骗人。
     */
    const dead = found
      .filter((f) => f.selfUses === 0 && f.testUses === 0)
      .map((f) => `${f.file} → ${f.name}`);
    assert.deepEqual(
      dead,
      [],
      `这些导出没有任何调用方：\n  ${dead.join("\n  ")}\n` +
        "要么接上，要么删掉 —— 留着它读起来像有人在守着，实际什么都没守",
    );
  });
});

describe("**只有测试在用的：钉一份清单**", () => {
  /*
   * 这一档不全是错的。
   *
   * 这个仓库刻意把一批纯规则函数拆成独立文件，「为了能被测试直接引用，
   * 不必拖进整个数据库依赖」—— 那种情况下生产代码调的是包着它的那一层。
   *
   * 但它同样是「一条规则其实没在生产里跑」的藏身处。所以不禁止，
   * 只要求**新增一个就得动这张表** —— 动表的时候顺手问一句：
   * 这条规则在生产里到底跑不跑。
   */
  it("清单和代码对得上", () => {
    const names = found
      .filter((f) => f.selfUses === 0 && f.testUses > 0)
      .map((f) => `${f.file} → ${f.name}`)
      .sort();

    assert.deepEqual(
      names,
      TEST_ONLY,
      "「只有测试在用」的清单变了。新增的那个：它包着的规则在生产里跑吗？\n" +
        "跑 —— 那就接上真正的调用方；不跑 —— 那它就是个死开关。\n" +
        "确实只是为了可测才拆出来的，再把它加进 TEST_ONLY。",
    );
  });
});

/**
 * 只有测试在调的导出。
 *
 * 每一条都应该能回答：**它包着的规则，在生产里由谁执行。**
 * 答不上来的那些，是下一轮该清的。
 */
const TEST_ONLY: string[] = [
  "lib/a11y/audit.ts → auditSource",
  "lib/admin/moderators.ts → allBoardModerators",
  "lib/admin/posts.ts → listRepliesForAdmin",
  "lib/admin/posts.ts → summarizeSelection",
  "lib/alerts/dispatch.ts → undeliveredAlerts",
  "lib/audit.ts → audited",
  "lib/audit/coverage.ts → auditGaps",
  "lib/audit/preview-coverage.ts → previewGaps",
  "lib/auth/bind-queue-queries.ts → bindQueueSize",
  "lib/auth/identity.ts → shadowedUsernames",
  "lib/auth/login-name.ts → identifierKind",
  "lib/auth/passkey-policy.ts → privilegedPermissions",
  "lib/broadcast/announce-rules.ts → displayLabel",
  "lib/flags/registry.ts → isGatedPath",
  "lib/forum/bookmark-rules.ts → onFolderDeleted",
  "lib/forum/pin.ts → pinRemainingLabel",
  "lib/forum/search.ts → rebuildIndex",
  "lib/invites/rules.ts → ancestorsOf",
  "lib/invites/rules.ts → buildTree",
  "lib/invites/rules.ts → isValidCodeShape",
  "lib/llm/client.ts → describeLlm",
  "lib/members/queries.ts → allTagFacets",
  "lib/moderation/words.ts → normalizeForMatch",
  "lib/modules/registry.ts → findDependencyCycles",
  "lib/notifications/live.ts → resetWatcherForTest",
  "lib/notifications/store.ts → invalidatePrefsCache",
  "lib/notifications/webpush.ts → generateVapidKeys",
  "lib/points/economy.ts → transferFee",
  "lib/rbac/matrix-edit.ts → isRiskyChange",
  "lib/runtime/lease.ts → holderId",
  "lib/runtime/lease.ts → leaseHolder",
  "lib/seasons/rules.ts → seasonAt",
  "lib/shop/purchase.ts → auditStock",
  "lib/storage/prune.ts → reindexRange",
  "lib/storage/tiers.ts → changesFor",
  "lib/storage/tiers.ts → desiredState",
  "lib/storage/tiers.ts → tierFor",
  "lib/time.ts → hourOf",
  "lib/titles/queries.ts → titleByKey",
  "lib/titles/rules.ts → sourceLabel",
  "lib/uploads/queries.ts → myRecentUploads",
  "lib/uploads/queries.ts → uploaderOf",
  "lib/users/deletion-plan.ts → planFor",
];
