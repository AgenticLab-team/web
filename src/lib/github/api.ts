import "server-only";

import { env } from "@/lib/env";

import { GITHUB_API_BASE, GITHUB_TOKEN_URL } from "./oauth-rules";
import type { RepoFact } from "./repo-rules";
import type { PrCandidateFact, RepoCandidateFact } from "./prompt-rules";

/**
 * GitHub REST 客户端。
 *
 * ─────────────────────────────────────────
 * 只走「按定义就是公开的」那几个接口
 * ─────────────────────────────────────────
 *
 * 仓库用 `/users/{login}/repos`，动态用 `/users/{login}/events/public`。
 * 这两个接口**无论拿什么 token 去调都只返回公开数据** ——
 * 不是我们过滤掉了私有的，是它们根本不返回。
 *
 * 对照的反面是 `/user/repos`：同一个功能、少打几个字，
 * 但它会跟着 token 的 scope 走。哪天有人为了别的需求加了 `repo`，
 * 私有仓库就会**自动**出现在所有人的主页上，而没有任何一行代码改动
 * 看起来和这件事有关。接口选型在这里就是权限边界本身。
 *
 * ─────────────────────────────────────────
 * token 绝不进日志
 * ─────────────────────────────────────────
 *
 * 下面每一处 throw 和 console 都只带状态码与接口路径。
 * 把 response body 原样打出来是最常见的泄露方式 ——
 * 换 token 那一步的错误响应里就带着 client_secret 的回显。
 */

const TIMEOUT_MS = 12_000;

/** 带上站点名，GitHub 要求 UA；出问题时他们能看出是谁在打 */
const USER_AGENT = `${env.site.name.replace(/[^\x20-\x7e]/g, "") || "agenticlab"}-github-link`;

export class GithubApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
  ) {
    // 只说状态码和路径，**不带 body**
    super(`GitHub ${path} 返回 ${status}`);
    this.name = "GithubApiError";
  }
}

async function withTimeout(url: string, init: RequestInit, path: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
  } catch {
    // 网络错误的原始信息里可能带着完整 URL（含参数）—— 换成一句干净的
    throw new GithubApiError(0, path);
  } finally {
    clearTimeout(timer);
  }
}

async function getJson<T>(path: string, token: string | null): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": USER_AGENT,
  };
  /*
   * 没有 token 也能跑 —— 这几个接口本来就是公开的。
   * 区别只在限流：带 token 是每小时 5000 次，不带是**按服务器 IP** 60 次。
   * 所以 token 在这里的作用是配额，不是权限。
   */
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await withTimeout(`${GITHUB_API_BASE}${path}`, { headers }, path);
  if (!res.ok) throw new GithubApiError(res.status, path);
  return (await res.json()) as T;
}

export interface GithubUser {
  id: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  htmlUrl: string;
}

/**
 * 用 code 换 token。
 *
 * GitHub 在这个接口上有个坑：**出错时也返回 200**，
 * 错误信息在 body 里的 `error` 字段。只看 res.ok 的话，
 * 一个 `bad_verification_code` 会被当成成功，然后拿着 undefined 当 token 走下去。
 */
export async function exchangeCode(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<{ accessToken: string; scope: string }> {
  const res = await withTimeout(
    GITHUB_TOKEN_URL,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({
        client_id: input.clientId,
        client_secret: input.clientSecret,
        code: input.code,
        redirect_uri: input.redirectUri,
      }),
    },
    "/login/oauth/access_token",
  );

  if (!res.ok) throw new GithubApiError(res.status, "/login/oauth/access_token");

  const body = (await res.json()) as { access_token?: string; scope?: string; error?: string };
  // 只认 error 的**代码**，不回显 error_description —— 那里面会带回请求参数
  if (body.error || !body.access_token) throw new GithubApiError(400, "/login/oauth/access_token");

  return { accessToken: body.access_token, scope: body.scope ?? "" };
}

/** 换到 token 之后立刻问一句「你是谁」—— 这是绑定要记的全部身份信息 */
export async function fetchViewer(token: string): Promise<GithubUser> {
  const raw = await getJson<{
    id: number;
    login: string;
    name: string | null;
    avatar_url: string | null;
    html_url: string;
  }>("/user", token);

  return {
    // 存成字符串：GitHub 的 id 现在还在安全整数范围内，但没必要赌以后
    id: String(raw.id),
    login: raw.login,
    name: raw.name,
    avatarUrl: raw.avatar_url,
    htmlUrl: raw.html_url,
  };
}

interface RawRepo {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  fork: boolean;
  archived: boolean;
  private: boolean;
  created_at: string;
  pushed_at: string | null;
}

/**
 * 这个人自己的公开仓库。
 *
 * `type=owner` 排掉他有权限但不是他的（组织仓库、协作仓库）——
 * 主页上那一栏说的是「他的项目」，把公司的仓库摆上去是另一回事。
 */
export async function fetchPublicRepos(login: string, token: string | null): Promise<RepoFact[]> {
  const raw = await getJson<RawRepo[]>(
    `/users/${encodeURIComponent(login)}/repos?type=owner&sort=updated&per_page=100`,
    token,
  );

  return raw.map((r) => ({
    id: String(r.id),
    fullName: r.full_name,
    name: r.name,
    description: r.description,
    htmlUrl: r.html_url,
    language: r.language,
    stars: r.stargazers_count,
    forks: r.forks_count,
    isFork: r.fork,
    archived: r.archived,
    isPrivate: r.private,
    createdAt: Date.parse(r.created_at) || 0,
    pushedAt: r.pushed_at ? Date.parse(r.pushed_at) || 0 : 0,
  }));
}

export function toRepoCandidates(repos: RepoFact[]): RepoCandidateFact[] {
  return repos.map((r) => ({
    id: r.id,
    name: r.name,
    fullName: r.fullName,
    description: r.description,
    htmlUrl: r.htmlUrl,
    language: r.language,
    stars: r.stars,
    isFork: r.isFork,
    isPrivate: r.isPrivate,
    createdAt: r.createdAt,
  }));
}

interface RawEvent {
  type: string;
  created_at: string;
  repo?: { name: string };
  payload?: {
    action?: string;
    pull_request?: {
      number: number;
      title: string;
      html_url: string;
      merged: boolean;
      created_at: string;
      base?: { repo?: { private?: boolean; description?: string | null; full_name?: string } };
    };
  };
}

/**
 * 最近合并的 PR。
 *
 * 走公开动态流而不是 Search API，有两个原因：
 *   · Search 的限流是每分钟 30 次，而且和全站共享 ——
 *     几十个人一起刷新就会互相把对方挤掉
 *   · 动态流一次请求就够，而且它**天然只有最近的事**，
 *     正好对应「新的 PR」这个语义。用 Search 还得自己造时间窗。
 *
 * 代价是它只覆盖最近约 90 天 / 300 条 —— 对「提示你分享刚发生的事」
 * 来说完全够，对「补齐历史」来说不够，而我们不做后者。
 */
export async function fetchMergedPrs(login: string, token: string | null): Promise<PrCandidateFact[]> {
  const raw = await getJson<RawEvent[]>(
    `/users/${encodeURIComponent(login)}/events/public?per_page=100`,
    token,
  );

  const out: PrCandidateFact[] = [];
  for (const e of raw) {
    if (e.type !== "PullRequestEvent") continue;
    if (e.payload?.action !== "closed") continue;
    const pr = e.payload.pull_request;
    if (!pr?.merged) continue;

    const repoFullName = pr.base?.repo?.full_name ?? e.repo?.name;
    if (!repoFullName) continue;

    out.push({
      repoFullName,
      number: pr.number,
      title: pr.title,
      htmlUrl: pr.html_url,
      repoDescription: pr.base?.repo?.description ?? null,
      merged: true,
      /*
       * 用 PR 创建时间而不是合并时间：一个开了半年才合的 PR
       * 不该被当成「刚发生的事」推到人眼前。
       */
      createdAt: Date.parse(pr.created_at) || Date.parse(e.created_at) || 0,
      // 动态流本身只有公开事件，这一位是给下游那道过滤用的
      isPrivate: pr.base?.repo?.private === true,
    });
  }
  return out;
}
