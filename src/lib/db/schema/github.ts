import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { now, ulidPk } from "./_shared";

/**
 * GitHub 绑定。
 *
 * ─────────────────────────────────────────
 * 为什么不复用 user_identities
 * ─────────────────────────────────────────
 *
 * users.ts 里那张表写着「预留 github」，但它只存得下「是谁」。
 * 这里还要存 access token、展示开关、置顶仓库 —— 一张会被
 * 到处 select 的身份表里混进一个凭证列，意味着每一次读身份
 * 都顺手把密文捞进内存，而且总有一天有人会 `select *` 之后
 * 把它序列化进 RSC 载荷。凭证要待在一张**只有绑定模块碰**的表里。
 *
 * ─────────────────────────────────────────
 * 两个唯一约束，各挡一件事
 * ─────────────────────────────────────────
 *
 * · `user_id` 唯一 —— 一个站内账号只能绑一个 GitHub。
 * · `github_user_id` 唯一 —— **一个 GitHub 账号不能绑到多个站内账号**。
 *   这一条是身份的底线：如果同一个 GitHub 能同时是两个人，
 *   那「主页上这个 GitHub 是他的」这句话就不再成立，
 *   而整个展示功能建立在这句话上。
 *
 * 用 github_user_id（数值 id）而不是 login 作唯一键：login 可以改名，
 * 改完之后原来的名字**会被别人注册走**，拿 login 当身份等于把身份
 * 绑在一个可转让的字符串上。
 */
export const githubConnections = sqliteTable(
  "github_connections",
  {
    id: ulidPk(),
    /** 站内账号。绑定只能由已登录的人发起 —— 这一列永远来自会话，不来自 GitHub */
    userId: text("user_id").notNull().unique(),
    /** GitHub 的数值 id，存成文本避免 JS 数字精度问题 */
    githubUserId: text("github_user_id").notNull().unique(),

    login: text("login").notNull(),
    name: text("name"),
    avatarUrl: text("avatar_url"),
    htmlUrl: text("html_url").notNull(),

    /**
     * access token 的密文（AES-256-GCM，见 lib/github/secret.ts）。
     *
     * 这个 token 的 scope 是**空的** —— 它能看到的东西任何一个
     * 匿名访客也能看到。即便如此还是要加密：一个能冒用的 token
     * 会把这个站的服务端变成别人 API 配额的免费代理，
     * 而「反正它没权限」是每一次凭证泄露事后都会听到的那句话。
     *
     * 允许为空：解密密钥换掉之后老密文读不出来，那时候宁可
     * 当作「没有 token」降级（数据变旧），也不能整页报错。
     */
    accessToken: text("access_token"),
    /** 实际拿到的 scope。存下来是为了能在后台核对「我们真的没要仓库权限」 */
    scope: text("scope").notNull().default(""),

    /**
     * 愿不愿意在主页上展示。**默认 false**。
     *
     * 绑定和展示是两件事：有人绑定只是想要那个「有新项目要不要发帖」
     * 的提醒，并不想让同群的人看见自己的 GitHub。
     * 默认打开的话，第一个绑定的人会在完全不知情的情况下
     * 把自己的全部公开仓库摆到主页上。
     */
    showOnProfile: integer("show_on_profile", { mode: "boolean" }).notNull().default(false),

    /**
     * 自己挑的置顶仓库（full_name 数组，最多 6 个）。
     * 空表示按默认排序（star 数 / 最近推送）自动选。
     */
    pinnedRepos: text("pinned_repos", { mode: "json" }),

    /** 要不要「有新项目/新 PR 可以发帖」的提示。想要展示但不想被提醒的人关掉它 */
    promptEnabled: integer("prompt_enabled", { mode: "boolean" }).notNull().default(true),

    connectedAt: now("connected_at"),
    updatedAt: now("updated_at"),
  },
  (t) => [index("github_connections_login_idx").on(t.login)],
);

/**
 * 仓库快照缓存。
 *
 * 每次渲染主页都去打 GitHub API 有两个问题：慢（跨境 300ms 起），
 * 以及**限流是按服务器 IP 算的** —— 一个人不停刷新主页，
 * 会把所有人的 GitHub 数据一起打没。所以渲染只读这张表，
 * 一次网络请求都不发；刷新是另一条路（见 lib/github/repos.ts）。
 *
 * error / attemptedAt 单独记：抓取失败时**不覆盖上一次的好数据**，
 * 否则一次网络抖动会让别人主页上的项目突然消失。
 */
export const githubRepoCache = sqliteTable("github_repo_cache", {
  userId: text("user_id").primaryKey(),
  /** RepoFact[] 的 JSON，见 lib/github/repo-rules.ts */
  repos: text("repos", { mode: "json" }).notNull(),
  fetchedAt: integer("fetched_at").notNull(),
  /** 最近一次**尝试**的时间，成功失败都记 —— 限流用它，不然失败可以无限重试 */
  attemptedAt: integer("attempted_at"),
  /** 上次失败的原因；成功时清空 */
  error: text("error"),
});

/**
 * 「要不要把这个发成帖子」的提示。
 *
 * ─────────────────────────────────────────
 * 这张表的主键作用不是存提示，是**记住提示过了**
 * ─────────────────────────────────────────
 *
 * (user_id, subject_key) 唯一。写入一律 INSERT OR IGNORE：
 * 一个仓库、一个 PR 只要进过这张表，之后无论用户采纳、
 * 拒绝还是根本没看见，检测都不会再把它变成第二条提示。
 *
 * 也就是说**「提示过了」不是一个额外的状态位，而是这一行的存在本身**。
 * 靠状态位的话，任何一次漏改状态都会让提示复活；
 * 而复活的提示是这个功能唯一的失败模式 —— 一个消不掉的红点。
 *
 * status 的五个值里，只有 pending 会显示：
 *   baseline  绑定当天就已经存在的东西。**不提示** —— 见 prompt-rules.ts
 *   pending   待处理，这是唯一会出现在页面上的
 *   dismissed 本人点了「不用了」
 *   shared    本人真的去发了帖，post_id 记着发的哪一篇
 *   expired   摆了两周没人理，自动收起来（见 PROMPT_TTL_DAYS）
 */
export const githubSharePrompts = sqliteTable(
  "github_share_prompts",
  {
    id: ulidPk(),
    userId: text("user_id").notNull(),
    kind: text("kind", { enum: ["repo", "pr"] }).notNull(),
    /** `repo:<github repo id>` 或 `pr:<owner/repo>#<number>`，见 prompt-rules.ts */
    subjectKey: text("subject_key").notNull(),

    title: text("title").notNull(),
    url: text("url").notNull(),
    summary: text("summary"),
    repoFullName: text("repo_full_name"),

    status: text("status", {
      enum: ["baseline", "pending", "dismissed", "shared", "expired"],
    })
      .notNull()
      .default("pending"),

    /** 这个仓库建好 / 这个 PR 提交的时间，不是我们发现它的时间 */
    subjectAt: integer("subject_at").notNull(),
    createdAt: now("created_at"),
    resolvedAt: integer("resolved_at"),
    /** 采纳之后发出来的那一篇 */
    postId: text("post_id"),
  },
  (t) => [
    uniqueIndex("github_prompts_subject_idx").on(t.userId, t.subjectKey),
    index("github_prompts_user_status_idx").on(t.userId, t.status),
  ],
);

/**
 * 帖子正文里提到的 GitHub 东西 —— 一份**全站共用**的事实缓存。
 *
 * ═════════════════════════════════════════
 * 为什么不能把卡片直接烤进正文 HTML
 * ═════════════════════════════════════════
 *
 * 帖子的 HTML 是**发表那一刻渲染好存下来的**（`forum_posts.content_html`）。
 * 把「★ 1.2k」写进去的话，那个数字就永远停在发帖那天，
 * 而且看不出它是旧的 —— 一个停住的数字比没有数字更坏。
 *
 * 所以正文里存的始终只是一条普通链接，卡片在**读的时候**才从这张表拼出来。
 *
 * ═════════════════════════════════════════
 * 按 ref 存，不按帖子存
 * ═════════════════════════════════════════
 *
 * 同一个仓库会被十个人在十篇帖子里贴到。按帖子存等于同一份事实抄十遍，
 * 刷新时要么漏掉几份、要么问十遍 —— 而 GitHub 的配额是按小时算的。
 *
 * 主键是 `lib/github/link-refs.ts` 的 refKey：issue 和 PR 共用一个键，
 * 因为在 GitHub 那边它们本来就是同一个编号空间。
 */
export const githubFacts = sqliteTable("github_facts", {
  /** refKey：`repo:owner/name` / `issue:owner/name#12` / `code:owner/name@sha/path#L1-L9` */
  key: text("key").primaryKey(),
  kind: text("kind", { enum: ["repo", "issue", "pr", "commit", "code"] }).notNull(),
  /** 点过去的地址。**以我们解析出来的为准**，不用接口回的 —— 仓库改名后两者会不一致 */
  url: text("url").notNull(),
  title: text("title").notNull(),
  summary: text("summary"),
  /**
   * 代码永久链接展开出来的那一段 —— **已经高亮好、消过毒的 HTML**。
   * 别的种类为空。
   *
   * ─────────────────────────────────────────
   * 这一列是「烤进去」的，而上面那条注释说不能烤 —— 两者不冲突
   * ─────────────────────────────────────────
   *
   * 不能烤的是会变的东西：`★ 1.2k` 写死在正文里，那个数字会永远
   * 停在发帖那天，而且看不出它是旧的。
   *
   * 这一段不会变：解析层**只认带 40 位 sha 的**代码链接，
   * 一个 sha 指向的内容是不可能改的。所以高亮放在取回来的那一刻做，
   * 而不是每一次有人打开帖子时重做一遍 —— 后者是把一件
   * 结果永远相同的 CPU 活儿，摊到每一个读者身上。
   */
  body: text("body"),
  /**
   * 问到的时间。
   *
   * 和资源库那边同一个用法：问过但对方说没有（删了 / 转私有）时，
   * 这里有值而 title 为空串 —— 靠它区分「还没问过」和「问过了，确实没有」。
   * 没有这个区分的话，一个删掉的仓库会被每一次渲染重新问一遍。
   */
  checkedAt: integer("checked_at").notNull(),
  /** 对方说没有。为真时不渲染卡片，正文里那条链接原样留着 */
  gone: integer("gone", { mode: "boolean" }).notNull().default(false),
});
