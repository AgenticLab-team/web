import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { now, ulidPk } from "./_shared";

/**
 * 开放 API 的令牌。
 *
 * ═════════════════════════════════════════
 * 只存哈希，明文只在创建那一刻出现一次
 * ═════════════════════════════════════════
 *
 * 存明文的话，一次数据库泄漏 = 所有人的令牌一起泄漏，
 * 而其中一部分带着「往一千六百人的群里发消息」的权限。
 *
 * 用 SHA-256 而不是 scrypt/bcrypt：令牌是**我们自己生成的 256 位随机数**，
 * 没有字典可以拿来猜，慢哈希在这里只换来每次请求几十毫秒的延迟。
 * （密码不一样 —— 那是人选的，所以 `credentials` 那张表用的是 scrypt。）
 */
export const apiTokens = sqliteTable(
  "api_tokens",
  {
    id: ulidPk(),
    userId: text("user_id").notNull(),
    /** 人给它起的名字，用来回答「这把是干什么的」 */
    name: text("name").notNull(),
    /**
     * 明文的前几位。
     *
     * 列表上要能回答「我撤销的是哪一把」—— 只显示名字不够，
     * 人给令牌起的名字经常是「测试」「新的」「1」。
     */
    visible: text("visible").notNull(),
    /** SHA-256(明文)，hex */
    hash: text("hash").notNull(),
    /** ScopeKey[] 的 JSON，见 lib/api-tokens/rules.ts */
    scopes: text("scopes", { mode: "json" }).notNull(),

    createdAt: now("created_at"),
    /**
     * 最后一次用是什么时候。
     *
     * 这一列存在的理由是**能清理**：一把半年没动过的令牌，
     * 十有八九是某次调试留下的，而它仍然能发消息。
     * 没有这一列的话，「哪些该撤掉」这个问题没有任何依据。
     */
    lastUsedAt: integer("last_used_at"),
    /** 到期时间；null = 不过期 */
    expiresAt: integer("expires_at"),
    /** 撤销之后**不删行** —— 审计日志里会引用它，删了那些记录就成了孤儿 */
    revokedAt: integer("revoked_at"),
    revokedReason: text("revoked_reason"),
  },
  (t) => [
    // 校验时按 hash 找 —— 必须是唯一索引，否则每次请求都是一次全表扫描
    uniqueIndex("api_tokens_hash_idx").on(t.hash),
    index("api_tokens_user_idx").on(t.userId, t.createdAt),
  ],
);

/**
 * 通过 API 发出去的每一条消息。
 *
 * ═════════════════════════════════════════
 * 两个用途，缺一不可
 * ═════════════════════════════════════════
 *
 * ① **限流**。上游的额度是 20 条/分钟、200 条/小时，而且
 *    **全站共用一把 key** —— 成员的令牌、站长的群发、告警投递
 *    抢的是同一个池子。按时间窗口数这张表，才谈得上给单把令牌设上限。
 *
 * ② **留痕**。消息发出去署名是机器人，群里的人看不出是谁发的。
 *    没有这张表的话，「这条是谁让机器人说的」永远答不上来 ——
 *    而那正是出事那天唯一要问的问题。
 *
 * 失败的也记（`ok` 为假），否则「试了一百次都失败」在限流上等于没发生。
 */
export const apiSends = sqliteTable(
  "api_sends",
  {
    id: ulidPk(),
    tokenId: text("token_id").notNull(),
    userId: text("user_id").notNull(),
    convId: text("conv_id").notNull(),
    length: integer("length").notNull(),
    /**
     * **发出去的正文，原样存**。
     *
     * 这一列一开始刻意没有：留痕不等于把所有人的消息再抄一份。
     * 站长改了口径（「审计代发内容」），而这个改动是对的 ——
     * 代发内容和普通聊天记录不是一回事：
     *
     *   · 普通消息是**他自己**说的，我们只是镜像
     *   · 这里是**机器人以他的名义**说的，出事时要答的是
     *     「机器人到底说了什么」—— 只有长度答不上来
     *
     * 存的是**拼好署名之后**的整条，也就是群里真正看到的那一条：
     * 存正文的话，署名那一行是不是真的加上了就成了一件查不出来的事。
     */
    text: text("text"),
    ok: integer("ok", { mode: "boolean" }).notNull(),
    error: text("error"),
    /** 上游返回的消息 id，撤回要用 */
    msgSvrId: text("msg_svr_id"),
    at: integer("at").notNull(),
  },
  (t) => [
    // 限流按 (token, 时间) 数
    index("api_sends_token_idx").on(t.tokenId, t.at),
    index("api_sends_conv_idx").on(t.convId, t.at),
  ],
);

/**
 * 「某人可以往某个群发消息」的授权。
 *
 * ═════════════════════════════════════════
 * 这是一条**逐群**的授权，不是一个身份
 * ═════════════════════════════════════════
 *
 * 站长原话：「也可以是授予某个人在某个群的发送权限，
 * 之后他可以通过 api 调用 也可以通过网页调用」。
 *
 * 所以它不叫「群主」也不叫「负责人」—— 那些是身份，
 * 而身份会让人以为跟着来了一堆别的权力（改群名、踢人……）。
 * 这里给的就是一件事：**在这个群里说话**。
 *
 * ═════════════════════════════════════════
 * 顺带说清楚为什么不从上游读群主
 * ═════════════════════════════════════════
 *
 * 实测上游的成员接口只给 `wx_id / name / group_nickname /
 * avatar / avatar_full / messages / left` —— **没有群主、没有管理员**。
 * 库里那个 `group_members.is_admin` 也指望不上：2041 行里
 * 一行都不是 1，从来没被写进过值。
 *
 * 所以这张表是唯一的真源，而它由站长填。
 */
export const groupSendGrants = sqliteTable(
  "group_send_grants",
  {
    convId: text("conv_id").notNull(),
    userId: text("user_id").notNull(),
    /** 谁给的、为什么 —— 这是一次授权，要说得出来源 */
    grantedBy: text("granted_by").notNull(),
    reason: text("reason"),

    /*
     * ── 这一条授权自己的限流 ──────────────────────────
     *
     * 站长：「授权也可以设置 rate limit」。
     *
     * 全局那份（`SEND_LIMIT`）保的是**全站不被一个人吃干**；
     * 这一份保的是**单个群不被一个人刷屏** —— 两件事。
     * 一个每天发两条通知的机器人和一个做互动玩法的机器人，
     * 该给的额度差一个数量级，而全局那份只能按最保守的那个定。
     *
     * null = 跟着全局走。**取两者更严的那个**：
     * 授权上的额度只能收紧，不能放宽 —— 否则站长在这里填一个大数，
     * 就能绕过那条「给公告和告警留余量」的底线。
     */
    perMinute: integer("per_minute"),
    perHour: integer("per_hour"),
    perDay: integer("per_day"),
    createdAt: now("created_at"),
    /**
     * 收回不删行。
     *
     * 删掉的话，`api_sends` 里那些消息就再也解释不清
     * 「他当时凭什么能发」——而那正是事后唯一要问的问题。
     */
    revokedAt: integer("revoked_at"),
  },
  (t) => [
    uniqueIndex("group_send_grants_pk").on(t.convId, t.userId),
    index("group_send_grants_user_idx").on(t.userId),
  ],
);
