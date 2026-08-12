import "server-only";

import { env } from "@/lib/env";
import { recordApiCall } from "@/lib/upstream/usage";
import type {
  SendHistoryEntry,
  SendQuota,
  SendResult,
  SendTarget,
  ActivityResponse,
  Conversation,
  FriendRequestsResponse,
  GroupMember,
  LeaderboardResponse,
  MessageQuery,
  MessagesResponse,
  Overview,
  UpstreamMessage,
  UserGroupsResponse,
  UserProfile,
  UserSearchResult,
  WhoAmI,
} from "./types";

/**
 * 上游不可用与上游拒绝要分开处理：
 * 隧道断了应该降级到本地缓存，参数写错了应该直接报错。
 */
export class NekoBotError extends Error {
  constructor(
    message: string,
    readonly kind: "unreachable" | "timeout" | "http" | "malformed",
    readonly status?: number,
  ) {
    super(message);
    this.name = "NekoBotError";
  }

  /** 上游侧问题，本地缓存可以顶上 */
  get isUpstreamDown() {
    return this.kind === "unreachable" || this.kind === "timeout" || (this.status ?? 0) >= 500;
  }
}

type QueryValue = string | number | boolean | undefined | null;

function buildQuery(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

const RETRYABLE_ATTEMPTS = 3;

/**
 * 各端点的 limit 上限（实测得来，文档未写）。
 * 超过会直接 422，而不是被截断 —— 曾经把 friend-requests 传成 500，
 * 整个请求失败，头像同步静默地一个都没拿到。
 */
const LIMIT_CEILING: Record<string, number> = {
  "/friend-requests": 200,
  "/messages": 500,
  "/conversations": 500,
  "/users/search": 200,
};

function clampLimit(path: string, limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  const key = Object.keys(LIMIT_CEILING).find((p) => path.startsWith(p));
  const ceiling = key ? LIMIT_CEILING[key] : undefined;
  return ceiling ? Math.min(limit, ceiling) : limit;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let lastError: NekoBotError | undefined;

  for (let attempt = 1; attempt <= RETRYABLE_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.nekobot.timeoutMs);
    /*
     * 记账在**每一次尝试**上，不是每个逻辑调用。
     *
     * 一次「重试两次才成功」，上游那侧确实收了三个请求、扣了三次配额、
     * 报了两次错。按逻辑调用记的话它会显示成一次干净的 200 ——
     * 而那正好把「上游最近在报错」这件事抹掉了。
     */
    const startedAt = Date.now();
    let logged = false;
    const log = (status: number | undefined, error?: string) => {
      if (logged) return;
      logged = true;
      recordApiCall({ path, status, latencyMs: Date.now() - startedAt, error });
    };

    try {
      const response = await fetch(`${env.nekobot.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          "X-API-Key": env.nekobot.apiKey,
          Accept: "application/json",
          /*
           * ═════════════════════════════════════════
           * 带 body 就必须声明 Content-Type
           * ═════════════════════════════════════════
           *
           * 少了这一行，`fetch` 会自作主张填 `text/plain;charset=UTF-8` ——
           * 而上游是 FastAPI，它按 Content-Type 决定怎么解析请求体：
           * 拿到 text/plain 时，那串 JSON 被当成**一个字符串**交给 pydantic，
           * 于是每一次 POST 都回 422：
           *
           *   {"type":"model_attributes_type",
           *    "msg":"Input should be a valid dictionary or object…",
           *    "input":"{\"conv_id\":\"…\",\"text\":\"…\"}"}
           *
           * 注意 `input` 里那串东西**看起来完全正确** —— 它就是我们要发的
           * 那个 JSON。所以读这条报错的人会一遍遍检查自己的字段名，
           * 而问题根本不在正文里，在一个没写的头上。
           *
           * 这条影响的是**所有** POST：发消息、撤回、通过好友申请、改群公告。
           * 也就是说站里从来没有成功发出去过一条 —— 而它一直安静地
           * 记成「发送失败：上游返回 422」，看起来像上游的问题。
           *
           * 放在这里而不是每个调用点：调用点有八个，第九个一定会忘。
           */
          ...(init?.body ? { "Content-Type": "application/json" } : {}),
          ...init?.headers,
        },
        // 上游数据由同步任务落库，这里永远取实时值
        cache: "no-store",
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        log(response.status, body.slice(0, 300));
        const error = new NekoBotError(
          `上游返回 ${response.status}: ${body.slice(0, 200)}`,
          "http",
          response.status,
        );
        // 4xx 是我们自己的问题，重试没有意义
        if (response.status < 500) throw error;
        lastError = error;
      } else {
        try {
          const parsed = (await response.json()) as T;
          log(response.status);
          return parsed;
        } catch {
          // 状态码是 200 但正文不是 JSON —— 记成它真实的样子，别记成成功
          log(response.status, "上游返回的不是合法 JSON");
          throw new NekoBotError("上游返回的不是合法 JSON", "malformed");
        }
      }
    } catch (err) {
      if (err instanceof NekoBotError) {
        if (!err.isUpstreamDown) throw err;
        lastError = err;
      } else if (err instanceof Error && err.name === "AbortError") {
        // 没有状态码 —— 这和 500 是两回事：一个去看隧道，一个去看上游服务
        log(undefined, `上游超时（${env.nekobot.timeoutMs}ms）`);
        lastError = new NekoBotError(`上游超时（${env.nekobot.timeoutMs}ms）`, "timeout");
      } else {
        const message = err instanceof Error ? err.message : String(err);
        log(undefined, `连接上游失败：${message}`);
        lastError = new NekoBotError(`连接上游失败：${message}`, "unreachable");
      }
    } finally {
      clearTimeout(timer);
    }

    if (attempt < RETRYABLE_ATTEMPTS) {
      await sleep(300 * 2 ** (attempt - 1));
    }
  }

  throw lastError ?? new NekoBotError("上游请求失败", "unreachable");
}

export const nekobot = {
  whoami: () => request<WhoAmI>("/whoami"),

  overview: () => request<Overview>("/stats/overview"),

  conversations: (params: {
    groups_only?: boolean;
    bound_only?: boolean;
    keyword?: string;
    limit?: number;
  } = {}) =>
    request<Conversation[]>(
      `/conversations${buildQuery({ ...params, limit: clampLimit("/conversations", params.limit) })}`,
    ),

  leaderboard: (
    convId: string,
    params: {
      days?: number;
      start_ms?: number;
      end_ms?: number;
      quality_min?: number;
      limit?: number;
      order?: "messages" | "quality_messages" | string;
    } = {},
  ) =>
    request<LeaderboardResponse>(
      `/groups/${encodeURIComponent(convId)}/leaderboard${buildQuery(params)}`,
    ),

  activity: (convId: string, params: { days?: number; by?: "hour" | "day" } = {}) =>
    request<ActivityResponse>(
      `/groups/${encodeURIComponent(convId)}/activity${buildQuery(params)}`,
    ),

  members: (convId: string, params: { limit?: number } = {}) =>
    request<GroupMember[]>(`/groups/${encodeURIComponent(convId)}/members${buildQuery(params)}`),

  searchUsers: (q: string, limit = 20) =>
    request<UserSearchResult[]>(
      `/users/search${buildQuery({ q, limit: clampLimit("/users/search", limit) })}`,
    ),

  userProfile: (wxId: string, params: { quality_min?: number; samples?: number } = {}) =>
    request<UserProfile>(`/users/${encodeURIComponent(wxId)}${buildQuery(params)}`),

  userGroups: (wxId: string, params: { quality_min?: number; days?: number } = {}) =>
    request<UserGroupsResponse>(
      `/users/${encodeURIComponent(wxId)}/groups${buildQuery(params)}`,
    ),

  messages: (query: MessageQuery = {}) =>
    request<MessagesResponse>(
      `/messages${buildQuery({ ...query, limit: clampLimit("/messages", query.limit) })}`,
    ),

  friendRequests: (params: { pending_only?: boolean; limit?: number } = {}) =>
    request<FriendRequestsResponse>(
      `/friend-requests${buildQuery({ ...params, limit: clampLimit("/friend-requests", params.limit) })}`,
    ),

  /**
   * 通过好友申请。
   *
   * ⚠️ 微信对频繁通过好友有风控。绑定流程**不需要**调用它 ——
   * /friend-requests 不通过也能拿到 wx_id、昵称、头像和活跃度。
   * 只在管理员后台手动、限速地使用。
   */
  acceptFriendRequest: (wxId: string) =>
    request<unknown>(`/friend-requests/${encodeURIComponent(wxId)}/accept`, { method: "POST" }),

  // ── 发送侧 ──────────────────────────────────────────────
  //
  // 这是全站唯一能主动向一千六百人发消息的能力。
  // 用户定的规矩：**网站不能替用户发消息**，只有系统/管理员公告能发。
  // 所以这里只暴露最小面：查额度、查可发目标、发文本、撤回。

  /** 当前 key 的发送额度。发之前必须查 —— 撞上限被上游拒是最难解释的失败 */
  sendQuota: () => request<SendQuota>("/send/quota"),

  /** 可发送的会话。群和私聊混在一起，调用方自己按 is_group 过滤 */
  sendTargets: () => request<SendTarget[]>("/send/targets"),

  sendHistory: () => request<SendHistoryEntry[]>("/send/history"),

  /**
   * 发一条文本。
   *
   * **不可逆**（撤回窗口很短且不保证成功）。调用前该做的检查
   * 全部在 broadcast 那一层，这里只负责发。
   */
  sendText: (convId: string, text: string) =>
    request<SendResult>("/send/text", {
      method: "POST",
      body: JSON.stringify({ conv_id: convId, text }),
    }),

  /**
   * 读群公告。
   *
   * 上游后来加的。在这之前「群公告」在我们的文档里挂在「做不到的」那一栏 ——
   * 现在能做了，那一栏就得改，否则它比没有更糟：它会让人不去试。
   */
  announcement: (convId: string) =>
    request<{ text: string | null; updated_at?: number | null }>(
      `/groups/${encodeURIComponent(convId)}/announcement`,
    ),

  /**
   * 改群公告。
   *
   * ⚠️ 这是**整条替换**，不是追加 —— 一次调用会覆盖群里现有的公告，
   * 而公告是一千六百人打开群就看见的那段字。所以调用方必须先读一遍
   * 给人看，见 lib/api-tokens/announce.ts。
   */
  setAnnouncement: (convId: string, text: string) =>
    request<SendResult>(`/groups/${encodeURIComponent(convId)}/announcement`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),

  /** 撤回自己发的消息。微信只允许很短的窗口，失败是常态，不能当成保证 */
  revoke: (convId: string, msgSvrId: string) =>
    request<SendResult>("/send/revoke", {
      method: "POST",
      body: JSON.stringify({ conv_id: convId, msg_svr_id: msgSvrId }),
    }),

  /**
   * 分页拉取消息。上游单次有 limit 上限，这里按页迭代。
   * 用于同步任务，不要在请求链路里直接调用。
   */
  async *iterateMessages(
    query: Omit<MessageQuery, "limit" | "offset">,
    pageSize = 500,
  ): AsyncGenerator<UpstreamMessage[]> {
    let offset = 0;
    for (;;) {
      const page = await this.messages({ ...query, limit: pageSize, offset });
      if (page.items.length === 0) return;
      yield page.items;
      offset += page.items.length;
      if (offset >= page.total || page.items.length < pageSize) return;
    }
  },
};
