import "server-only";

import { eq } from "drizzle-orm";

import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { githubConnections, githubRepoCache, githubSharePrompts } from "@/lib/db/schema";

import type { GithubUser } from "./api";
import type { LinkFailure } from "./oauth-rules";
import { encryptToken } from "./secret";

/**
 * 绑定与解绑。
 *
 * ═════════════════════════════════════════
 * 这个文件里没有、也永远不能有「创建账号」和「建立会话」
 * ═════════════════════════════════════════
 *
 * 这个站有一条硬约束：**只有群成员能登录**。账号是靠在微信群里
 * 收验证码建立的，这一条是整个站的门。
 *
 * GitHub 绑定如果顺手做成「用 GitHub 登录」，那道门就等于拆了 ——
 * 全世界任何一个有 GitHub 账号的人都能进来。而且这种事**不会有人发现**：
 * 站长自己点「用 GitHub 登录」是能进的，一切看起来都正常。
 *
 * 所以绑定的入口只有一个形态：
 *
 *     一个**已经登录**的人，给自己的账号加一个绑定。
 *
 * `linkGithub()` 的第一个参数是 userId，它只能来自 `getRealUser()`。
 * 这个文件不 import session 的写入口、不 insert users、
 * 不 set cookie —— tests/github-oauth.test.ts 会逐条核对这几件事，
 * 因为这是那种「改错一次、错很久、错得没人知道」的地方。
 */

export interface GithubConnection {
  id: string;
  userId: string;
  githubUserId: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  htmlUrl: string;
  scope: string;
  showOnProfile: boolean;
  /** 作者自荐语，以及它挂在哪个仓库（小写 `owner/repo`）。没自荐过就是 null */
  pitch: string | null;
  pitchRepo: string | null;
  pinnedRepos: string[];
  promptEnabled: boolean;
  connectedAt: number;
  /** 密文。调用方要用的话走 lib/github/repos.ts 里的解密，不要在别处解 */
  accessToken: string | null;
}

function toConnection(row: typeof githubConnections.$inferSelect): GithubConnection {
  return {
    id: row.id,
    userId: row.userId,
    githubUserId: row.githubUserId,
    login: row.login,
    name: row.name,
    avatarUrl: row.avatarUrl,
    htmlUrl: row.htmlUrl,
    scope: row.scope,
    showOnProfile: row.showOnProfile,
    pitch: row.pitch,
    pitchRepo: row.pitchRepo,
    pinnedRepos: Array.isArray(row.pinnedRepos) ? (row.pinnedRepos as string[]) : [],
    promptEnabled: row.promptEnabled,
    connectedAt: row.connectedAt,
    accessToken: row.accessToken,
  };
}

export function connectionOf(userId: string): GithubConnection | null {
  const row = db
    .select()
    .from(githubConnections)
    .where(eq(githubConnections.userId, userId))
    .get();
  return row ? toConnection(row) : null;
}

export type LinkResult =
  | { ok: true; connection: GithubConnection; firstTime: boolean }
  | { ok: false; reason: LinkFailure };

/**
 * 建立绑定。
 *
 * userId **必须**是当前登录的那个人 —— 调用方（回调路由）在调这里之前
 * 已经确认过会话存在。这里不再去猜、也不去创建任何账号：
 * 传进来一个不存在的 userId 的话，结果是一条挂在空账号上的绑定，
 * 而不是一个新用户。
 */
export function linkGithub(
  userId: string,
  viewer: GithubUser,
  token: { accessToken: string; scope: string },
  tokenKey: string,
): LinkResult {
  const existingHere = connectionOf(userId);
  if (existingHere) {
    /*
     * 已经绑过了。**同一个 GitHub 重复点绑定不算错** ——
     * 微信内置浏览器上「后退再前进」会重放这个回调，
     * 报一句「你已经绑过了」会让人以为出了问题。
     * 换一个 GitHub 才是真的要拦：那意味着换身份，得先解绑。
     */
    if (existingHere.githubUserId === viewer.id) {
      refreshProfile(userId, viewer, token, tokenKey);
      return { ok: true, connection: connectionOf(userId)!, firstTime: false };
    }
    return { ok: false, reason: "already_linked_here" };
  }

  const takenBy = db
    .select({ userId: githubConnections.userId })
    .from(githubConnections)
    .where(eq(githubConnections.githubUserId, viewer.id))
    .get();

  /*
   * 这个 GitHub 已经是别人的了。
   *
   * 先查一次再插，是为了给一句人话；**但真正拦住它的是唯一索引** ——
   * 查完到插入之间有一个窗口，两个请求同时挤进来的话只有约束挡得住。
   * 靠查询挡的并发漏洞是这类功能的经典写法，所以两层都要有。
   */
  if (takenBy && takenBy.userId !== userId) {
    return { ok: false, reason: "already_linked_elsewhere" };
  }

  try {
    db.insert(githubConnections)
      .values({
        userId,
        githubUserId: viewer.id,
        login: viewer.login,
        name: viewer.name,
        avatarUrl: viewer.avatarUrl,
        htmlUrl: viewer.htmlUrl,
        accessToken: encryptToken(token.accessToken, tokenKey),
        scope: token.scope,
      })
      .run();
  } catch {
    // 撞唯一索引 —— 就是上面那个并发窗口。给同一句话，不泄露是谁占着
    return { ok: false, reason: "already_linked_elsewhere" };
  }

  audit(
    { actorId: userId },
    {
      action: "user.github.link",
      targetType: "user",
      targetId: userId,
      // 记 login 不记 token。审计日志是后台能翻的，凭证不该有第二个副本
      after: { login: viewer.login, githubUserId: viewer.id, scope: token.scope },
    },
  );

  return { ok: true, connection: connectionOf(userId)!, firstTime: true };
}

/** 同一个 GitHub 再授权一次：把可能改过的头像 / 昵称 / token 更新掉 */
function refreshProfile(
  userId: string,
  viewer: GithubUser,
  token: { accessToken: string; scope: string },
  tokenKey: string,
) {
  db.update(githubConnections)
    .set({
      login: viewer.login,
      name: viewer.name,
      avatarUrl: viewer.avatarUrl,
      htmlUrl: viewer.htmlUrl,
      accessToken: encryptToken(token.accessToken, tokenKey),
      scope: token.scope,
      updatedAt: Date.now(),
    })
    .where(eq(githubConnections.userId, userId))
    .run();
}

/**
 * 解绑。**连缓存和提示一起删干净**。
 *
 * 只删绑定行的话，那个人的仓库快照还躺在库里，
 * 而「我已经解绑了」的人合理地认为那些数据不存在了。
 *
 * 提示记录也一起删 —— 代价是重新绑定后会被当成新人重新 baseline，
 * 那正是想要的：解绑再绑是一次明确的重来。
 */
export function unlinkGithub(userId: string): boolean {
  const before = connectionOf(userId);
  if (!before) return false;

  db.transaction((tx) => {
    tx.delete(githubConnections).where(eq(githubConnections.userId, userId)).run();
    tx.delete(githubRepoCache).where(eq(githubRepoCache.userId, userId)).run();
    tx.delete(githubSharePrompts).where(eq(githubSharePrompts.userId, userId)).run();
  });

  audit(
    { actorId: userId },
    {
      action: "user.github.unlink",
      targetType: "user",
      targetId: userId,
      before: { login: before.login, githubUserId: before.githubUserId },
    },
  );

  return true;
}

/** 展示开关。绑定 ≠ 同意公开展示，这是两次独立的点击 */
export function setShowOnProfile(userId: string, show: boolean): boolean {
  const before = connectionOf(userId);
  if (!before) return false;

  db.update(githubConnections)
    .set({ showOnProfile: show, updatedAt: Date.now() })
    .where(eq(githubConnections.userId, userId))
    .run();

  audit(
    { actorId: userId },
    {
      action: "user.github.visibility",
      targetType: "user",
      targetId: userId,
      before: { showOnProfile: before.showOnProfile },
      after: { showOnProfile: show },
    },
  );
  return true;
}

/** 要不要「新项目/新 PR」的提示。关掉之后一条都不再产生 */
export function setPromptEnabled(userId: string, enabled: boolean): boolean {
  if (!connectionOf(userId)) return false;
  db.update(githubConnections)
    .set({ promptEnabled: enabled, updatedAt: Date.now() })
    .where(eq(githubConnections.userId, userId))
    .run();
  return true;
}

/**
 * 写下（或撤掉）自荐语。
 *
 * `repoKey` 传 null = 撤掉自荐。自荐是**挂在某一个仓库上**的：
 * 一个人可能有二十个仓库，那句话只对其中一个成立 ——
 * 挂在人身上的话，他换了主力项目之后那句话会跟着挂到新项目上，
 * 而它说的还是旧项目的事。
 *
 * 留审计：这是一条会出现在**公共目录**上的、由用户自己写的文字。
 */
export function setPitch(userId: string, repoKey: string | null, text: string): boolean {
  const before = connectionOf(userId);
  if (!before) return false;

  const clearing = !repoKey || !text;
  db.update(githubConnections)
    .set({
      pitch: clearing ? null : text,
      pitchRepo: clearing ? null : repoKey.toLowerCase(),
      pitchAt: clearing ? null : Date.now(),
      updatedAt: Date.now(),
    })
    .where(eq(githubConnections.userId, userId))
    .run();

  audit(
    { actorId: userId },
    {
      action: "user.github.pitch",
      targetType: "user",
      targetId: userId,
      before: { pitchRepo: before.pitchRepo, pitch: before.pitch },
      after: clearing ? { pitchRepo: null } : { pitchRepo: repoKey.toLowerCase(), pitch: text },
      reason: clearing ? "撤掉项目自荐" : "写下项目自荐",
    },
  );
  return true;
}

export function setPinnedRepos(userId: string, pinned: string[]): boolean {
  if (!connectionOf(userId)) return false;
  db.update(githubConnections)
    .set({ pinnedRepos: pinned, updatedAt: Date.now() })
    .where(eq(githubConnections.userId, userId))
    .run();
  return true;
}

/** 按站内账号 id 取「可以公开展示的」绑定 —— 关了展示开关的一律当作没有 */
export function publicConnectionOf(userId: string): GithubConnection | null {
  const conn = connectionOf(userId);
  if (!conn || !conn.showOnProfile) return null;
  return conn;
}
