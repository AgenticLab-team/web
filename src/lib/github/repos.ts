import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { githubRepoCache } from "@/lib/db/schema";

import { fetchMergedPrs, fetchPublicRepos, toRepoCandidates } from "./api";
import { connectionOf } from "./link";
import { prCandidates, repoCandidates, selectPrompts } from "./prompt-rules";
import { knownSubjectKeys, pendingCount, recordPrompts } from "./prompts";
import { isStale, mayRefresh, showcaseRepos, type RepoFact } from "./repo-rules";
import { decryptToken, githubConfig } from "./secret";

/**
 * 仓库快照的缓存与刷新。
 *
 * ─────────────────────────────────────────
 * 谁来刷新：本人自己打开页面的时候，而且是在**页面发出去之后**
 * ─────────────────────────────────────────
 *
 * 三种做法里选了第三种：
 *
 *   ① 每次渲染都打 API —— 慢（跨境 300ms 起，还得串两个请求），
 *      而且限流按服务器 IP 算，一个人猛刷会把全站的额度耗光。
 *   ② 定时任务全量刷 —— 得给每个绑过的人都刷，包括三个月没登录的。
 *      为一个没人看的主页去消耗配额，纯浪费。
 *   ③ 本人打开自己的「我的」页时，用 after() 在响应发出**之后**刷。
 *
 * ③ 的好处是：渲染永远只读库、零网络，页面该多快还多快；
 * 而刷新只发生在真的有人在用这个功能的时候。
 * 代价是别人看他主页时数据可能旧几个小时 —— 一个人的项目列表
 * 半天没更新，没有任何人看得出来。
 *
 * 冷却期（REPO_REFRESH_COOLDOWN_MS）挡住猛刷：按钮点了也不一定真去抓。
 */

export interface CachedRepos {
  repos: RepoFact[];
  fetchedAt: number;
  attemptedAt: number | null;
  error: string | null;
}

const EMPTY: CachedRepos = { repos: [], fetchedAt: 0, attemptedAt: null, error: null };

export function cachedRepos(userId: string): CachedRepos {
  const row = db
    .select()
    .from(githubRepoCache)
    .where(eq(githubRepoCache.userId, userId))
    .get();
  if (!row) return EMPTY;
  return {
    repos: Array.isArray(row.repos) ? (row.repos as RepoFact[]) : [],
    fetchedAt: row.fetchedAt,
    attemptedAt: row.attemptedAt,
    error: row.error,
  };
}

/** 主页上那一栏要摆的仓库。**纯读库，一个网络请求都不发** */
export function showcaseFor(userId: string, pinned: string[]): RepoFact[] {
  return showcaseRepos(cachedRepos(userId).repos, pinned);
}

export interface RefreshOutcome {
  /** 真的去抓了吗（冷却期内 / 没绑定 / 没配置都会是 false） */
  attempted: boolean;
  ok: boolean;
  repoCount: number;
  /** 这一轮新产生了几条待处理提示 */
  newPrompts: number;
  error?: string;
}

/**
 * 抓一次并落库。
 *
 * `force` 只影响冷却判定，不影响别的 —— 用户点「刷新」时传 true，
 * 后台自动刷新传 false。**即使 force 也仍然受冷却限制**：
 * 一个能被绕过的限流等于没有限流。
 */
export async function refreshGithubData(
  userId: string,
  opts: { baseline?: boolean; now?: number } = {},
): Promise<RefreshOutcome> {
  const now = opts.now ?? Date.now();
  const config = githubConfig();
  if (!config) return { attempted: false, ok: false, repoCount: 0, newPrompts: 0 };

  const conn = connectionOf(userId);
  if (!conn) return { attempted: false, ok: false, repoCount: 0, newPrompts: 0 };

  const cache = cachedRepos(userId);
  if (!mayRefresh(cache.attemptedAt, now)) {
    return { attempted: false, ok: true, repoCount: cache.repos.length, newPrompts: 0 };
  }

  // 先把「尝试时间」写下去再出门。写在后面的话，一个卡住的请求
  // 期间涌进来的其它请求会全部通过冷却判定，一起打出去
  touchAttempt(userId, now, cache);

  const token = decryptToken(conn.accessToken, config.tokenKey);

  let repos: RepoFact[];
  try {
    repos = await fetchPublicRepos(conn.login, token);
  } catch (err) {
    const message = err instanceof Error ? err.message : "抓取失败";
    // 失败**不覆盖上一次的好数据** —— 一次网络抖动不该让别人主页上的项目消失
    db.update(githubRepoCache)
      .set({ error: message })
      .where(eq(githubRepoCache.userId, userId))
      .run();
    return { attempted: true, ok: false, repoCount: cache.repos.length, newPrompts: 0, error: message };
  }

  db.update(githubRepoCache)
    .set({ repos, fetchedAt: now, error: null })
    .where(eq(githubRepoCache.userId, userId))
    .run();

  /*
   * PR 那一路失败不算这一轮失败。
   *
   * 仓库列表是主页要用的（看得见），PR 只喂提示（看不见）。
   * 让后者的失败把前者一起拖掉，等于让一个次要功能决定主要功能的可用性。
   */
  let prs: Awaited<ReturnType<typeof fetchMergedPrs>> = [];
  if (conn.promptEnabled) {
    try {
      prs = await fetchMergedPrs(conn.login, token);
    } catch {
      prs = [];
    }
  }

  let newPrompts = 0;
  if (conn.promptEnabled) {
    const known = knownSubjectKeys(userId);
    /*
     * baseline 判定看的是**这个人有没有提示记录**，不是「是不是刚绑定」。
     *
     * 用「刚绑定」判断的话，第一次抓取失败之后第二次就会走 live，
     * 于是他历史上所有的仓库一次性变成提示 —— 而那正是
     * 「绑完收到 60 条提醒」的那个场景。
     */
    const mode = opts.baseline ?? known.size === 0 ? "baseline" : "live";
    const selected = selectPrompts({
      candidates: [...repoCandidates(toRepoCandidates(repos)), ...prCandidates(prs)],
      known,
      pendingCount: pendingCount(userId),
      now,
      mode,
    });
    recordPrompts(userId, selected);
    newPrompts = selected.filter((s) => s.status === "pending").length;
  }

  return { attempted: true, ok: true, repoCount: repos.length, newPrompts };
}

/** 旧了才刷。给 after() 用 —— 它跑在响应之后，抛异常也不会影响页面 */
export async function refreshIfStale(userId: string): Promise<void> {
  const now = Date.now();
  const cache = cachedRepos(userId);
  if (!isStale(cache.fetchedAt, now)) return;
  if (!mayRefresh(cache.attemptedAt, now)) return;
  try {
    await refreshGithubData(userId, { now });
  } catch {
    // 后台刷新失败就是数据旧一点。它绝不能变成一个用户看得见的错误
  }
}

function touchAttempt(userId: string, now: number, cache: CachedRepos) {
  if (cache.fetchedAt === 0 && cache.attemptedAt === null) {
    db.insert(githubRepoCache)
      .values({ userId, repos: [], fetchedAt: 0, attemptedAt: now })
      .onConflictDoUpdate({ target: githubRepoCache.userId, set: { attemptedAt: now } })
      .run();
    return;
  }
  db.update(githubRepoCache)
    .set({ attemptedAt: now })
    .where(eq(githubRepoCache.userId, userId))
    .run();
}
