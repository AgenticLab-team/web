import "server-only";

import { and, eq, isNull } from "drizzle-orm";

import { db } from "@/lib/db";
import { links } from "@/lib/db/schema";

import { githubJson } from "./api";
import { apiPathFor, issueFacts, repoFacts, shouldFetch, type LinkFacts } from "./link-facts";
import { parseGithubUrl, type GithubRef } from "./link-refs";

/**
 * 资源库里的 GitHub 链接：直接问 GitHub，别问模型。
 *
 * ═════════════════════════════════════════
 * 它插在整理流程的**前面**
 * ═════════════════════════════════════════
 *
 * 资源库原来的做法是把链接和上下文丢给模型，让它猜「这是什么」。
 * 对 GitHub 链接来说那是绕远路 —— 来源自己就会回答，而且是权威的。
 * 所以这一步先跑：能问出来的，模型那一趟连发都不用发。
 *
 * 落的是 `fact_*` 那几列，不是 `ai_*`。理由写在 schema 上：
 * 那两列分开存就是为了让界面能说清「哪一条是机器写的」，
 * 把权威信息塞进去会让那句提示本身变成假话。
 *
 * ═════════════════════════════════════════
 * 问不到也要记一笔
 * ═════════════════════════════════════════
 *
 * 仓库删了、转私有了、改名了 —— 这些都是**结论**，记下
 * `factCheckedAt`、留空 `factTitle`，下次不再问。
 *
 * 但网络错误、限流、超时**不能**记：那是故障。记了的话，
 * 一次抖动会让这一批链接**永远**不再被问一次，
 * 而且没有任何地方看得出来。（资源库那边踩过同一个坑，
 * 注释还在 enrich.ts 上。）
 */

/**
 * 去问 GitHub 的那一下。**做成参数**，测试才好把各种失败摆出来。
 *
 * 直接 import `githubJson` 也能跑，但那样就只能靠打桩 ESM 导出 ——
 * 而 ESM 的命名空间是冻住的，打不了。真正要紧的是：这个文件里
 * 值得测的**全部**是「失败怎么记」，而失败只能靠伪造对方的回答造出来。
 * 不给注入口，等于这些分支一条都测不到。
 */
export type Fetcher = (path: string) => Promise<Record<string, unknown>>;

export interface LookupReport {
  scanned: number;
  written: number;
  /** 问过了，GitHub 说没有（删了 / 转私有 / 本来就不存在） */
  gone: number;
  /** 故障：没记 checkedAt，下次还会再问 */
  failed: number;
  notes: string[];
}

/**
 * 入库时算好的域名，拿来做 SQL 预筛。
 *
 * 注意它**不是**安全判定 —— 判定在 parseGithubUrl 那一处，只有那一处。
 */
const GITHUB_DOMAIN = "github.com";

/** 一次跑多少条 —— 不带 token 时 GitHub 每小时只给 60 次 */
const DEFAULT_LIMIT = 30;

/**
 * GitHub 说「没有」的那几个状态码。
 *
 * 404 是删了 / 转私有 / 本来就没有；451 是法务下架。
 * 两个都是**关于这条链接的结论**，不是我们这边的故障。
 *
 * 403 **不在这里** —— 它绝大多数时候是限流（配额用完），
 * 是我们这边的问题。当成「没有」记下来的话，配额恢复之后
 * 这批链接也不会再被问。
 */
const GONE = new Set([404, 451]);

export async function lookupGithubLinks(
  options: { limit?: number; force?: boolean; fetcher?: Fetcher } = {},
): Promise<LookupReport> {
  const fetcher: Fetcher = options.fetcher ?? ((path) => githubJson(path));
  const report: LookupReport = { scanned: 0, written: 0, gone: 0, failed: 0, notes: [] };

  const candidates = db
    .select()
    .from(links)
    /*
     * 两个条件，各挡一件事。
     *
     * ① **问没问过只看 factCheckedAt**，不能再 or 上 `isNull(factTitle)`。
     *    加上那一条的话，一条 404 的链接（记了时间、标题留空 —— 那正是
     *    「问过了，确实没有」的表示法）会**永远**满足条件，
     *    于是每一轮都拿它去撞一次 404。配额就是这么白花掉的，
     *    而且外面看起来一切正常：报告里 gone 每轮 +1，没有任何地方喊。
     *
     * ② `domain` 是**预筛**，不是判定。少了它，`limit` 数的是
     *    「翻了多少行」而不是「问了多少条 GitHub 链接」——
     *    线上五百多条链接里 GitHub 只占 36 条，limit 30 实际只碰得上
     *    一两条，跑二十轮也补不完，而每一轮的输出都显示成功。
     *
     *    预筛可以宽（放进来的会被 parse 挡掉），但**绝不能反过来**拿它当判定：
     *    domain 是入库时算的，钓鱼域名（github.com.evil.com）的 domain
     *    本来就不是 github.com —— 靠它挡是碰巧挡住的，换个写法就漏。
     *    **安全边界只有一处，就是下面那个 parseGithubUrl。**
     */
    .where(
      options.force
        ? eq(links.domain, GITHUB_DOMAIN)
        : and(isNull(links.factCheckedAt), eq(links.domain, GITHUB_DOMAIN)),
    )
    .limit(options.limit ?? DEFAULT_LIMIT)
    .all()
    .map((link) => ({ link, ref: parseGithubUrl(link.url) }))
    .filter(
      (row): row is { link: (typeof links.$inferSelect); ref: GithubRef } =>
        row.ref !== null && shouldFetch(row.ref),
    );

  for (const { link, ref } of candidates) {
    report.scanned++;
    const path = apiPathFor(ref);
    if (!path) continue;

    let payload: Record<string, unknown>;
    try {
      payload = await fetcher(path);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (typeof status === "number" && GONE.has(status)) {
        // 这是关于这条链接的结论 —— 记下来，别再问
        db.update(links)
          .set({ factCheckedAt: Date.now(), factSource: "github" })
          .where(eq(links.id, link.id))
          .run();
        report.gone++;
        continue;
      }
      /*
       * 故障：不记 checkedAt。限流（403 / 429）时**直接停下** ——
       * 继续往下跑只会把剩下的每一条都换成一次失败，
       * 而每一次失败都要等一个超时。
       */
      report.failed++;
      report.notes.push(`${link.url}：${(error as Error).message}`);
      if (status === 403 || status === 429) {
        report.notes.push("GitHub 限流了，这一轮停在这里 —— 剩下的下次再问");
        break;
      }
      continue;
    }

    const facts: LinkFacts | null =
      ref.kind === "repo" ? repoFacts(ref, payload) : issueFacts(ref, payload);

    if (!facts) {
      // 回来了但读不出想要的字段 —— 是故障不是结论，下次还该再试
      report.failed++;
      report.notes.push(`${link.url}：回复里没有能用的字段`);
      continue;
    }

    db.update(links)
      .set({
        factTitle: facts.title,
        factSummary: facts.summary,
        factSource: "github",
        factCheckedAt: Date.now(),
      })
      .where(eq(links.id, link.id))
      .run();
    report.written++;
  }

  return report;
}

/**
 * 这条链接**已经**有权威事实了吗 —— 有就别再问模型。
 *
 * 整理流程拿它做前置判断：GitHub 那一份既准又免费，
 * 再花一次模型调用去猜同一件事，猜出来的还更差。
 */
export function hasAuthoritativeFacts(link: {
  factTitle: string | null;
  factSummary: string | null;
}): boolean {
  return link.factTitle !== null && link.factSummary !== null;
}
