/**
 * 建了、没人读的列。
 *
 * ─────────────────────────────────────────
 * 1058 列里有 23 列 src 里一次都没出现过
 * ─────────────────────────────────────────
 *
 * 一列空着不花钱，问题不在存储 —— 在于**它看起来是做过的**。
 * 下一个人读到 `invites.grant_role_id`，合理的结论是「邀请码能带角色」；
 * 读到 `user_privacy.hide_from_directory`，合理的结论是
 * 「隐私设置里有这一项」。两个结论都是错的，而代码没有一处告诉他。
 *
 * 更贵的一种：**同一件事有两列**。目录隐身真正在用的是
 * `users.directory_hidden`，而 `user_privacy.hide_from_directory`
 * 就在那儿等着谁把它接上 —— 接上之后就是两个开关管一件事，
 * 只拨了其中一个的人以为自己藏起来了。
 *
 * ─────────────────────────────────────────
 * 这张表要求的不是「删干净」，是「说得出实情」
 * ─────────────────────────────────────────
 *
 * 删列在 SQLite 上要重建整张表，比删一行配置重得多，
 * 而且有些是功能确实还没做。所以这里不逼着删，
 * 只逼着**每一列都有人给出过一句实情** ——
 * 新出现一列没人读的，`tests/dead-columns.test.ts` 会红。
 *
 * `disposition` 是给未来的人的下一步，不是标签：
 *
 *   · `duplicate` —— 同一件事已经有别的列在管。**最该删**，
 *     因为它随时会被谁接上，接上就是两套。
 *     这一类真的删掉了两个（`user_privacy.hide_from_directory`、
 *     `forum_posts.pinned_globally`）—— 靠 `ALTER TABLE ... DROP COLUMN`，
 *     删之前在从真备份恢复出来的副本上跑过一遍。
 *   · `decided-against` —— 想清楚之后主动没做，理由记在这里。
 *   · `superseded` —— 设计变了，这一列对应的那条路已经不存在。
 *   · `planned` —— 功能还没做，列先建着。
 *   · `gap` —— **本来就该写而没写**，是缺陷，不是遗留。
 *
 * ─────────────────────────────────────────
 * 这张表本身也会写错
 * ─────────────────────────────────────────
 *
 * `group_member_events.detected_at` 曾经被判成「和 created_at 重复」——
 * 而那张表**根本没有 created_at**，它是唯一的时间戳，还在索引里。
 * 差一点就按这条判断把它删了。
 *
 * 错的根源是探测器：只出现在 `index(...).on(...)` 里的列被报成
 * 「一次都没出现过」。现在索引也算引用了（但**只在这张表本身
 * 被用到时才算** —— 否则一张死表会把它所有的列都洗白）。
 *
 * 教训是：**先去看那张表长什么样，再写下判断**。
 * 名单上的每一句「为什么」都会被后来的人当成事实。
 *
 * 这一类真的会被清掉：`api_usage` 整张表曾经建了 763 天、0 行，
 * 标成 `gap` 之后接上了记账，这条测试立刻反过来报红
 * （「名单上的列已经接上了」），于是从名单上划掉。
 * 双向盯着才不会变成一张只进不出的清单。
 */

export interface DeadColumn {
  /** `表.列`，用数据库里的名字，不是 TS 属性名 —— 迁移和排查看的是这个 */
  column: string;
  disposition: "duplicate" | "decided-against" | "superseded" | "planned" | "gap";
  /** 实情。一句话说清「为什么它是空的」和「下一步该怎么办」 */
  why: string;
}

export const DEAD_COLUMNS: readonly DeadColumn[] = [
  /* ── 隐私 ────────────────────────────────────────────────── */
  {
    column: "user_privacy.hide_activity_hours",
    disposition: "decided-against",
    why: "这个开关守的是作息（几点睡几点起），而作息要逐小时的直方图才暴露得出来。成员目录只给「本周 / 本月」这一档粗粒度，没有可藏的东西 —— 理由写在 lib/members/queries.ts 里",
  },

  /* ── 身份 ────────────────────────────────────────────────── */
  {
    column: "user_identities.provider",
    disposition: "superseded",
    why: "整张 user_identities 表没有任何地方用。GitHub 绑定走的是 github_connections（有 token、有作用域、有校验），多账号体系没有做也暂时不需要",
  },
  {
    column: "user_identities.external_id",
    disposition: "superseded",
    why: "同 user_identities.provider",
  },
  {
    column: "user_identities.linked_at",
    disposition: "superseded",
    why: "同 user_identities.provider",
  },
  {
    column: "user_identities.unlinked_at",
    disposition: "superseded",
    why: "同 user_identities.provider",
  },
  {
    column: "users.email_verified_at",
    disposition: "planned",
    why: "站内没有邮箱验证流程 —— 登录靠微信绑定码和 Passkey。邮件群发做了之后才用得上（那时候要能区分「填过」和「验过」）",
  },
  {
    column: "users.phone_verified_at",
    disposition: "planned",
    why: "同 users.email_verified_at。手机号目前只是资料字段 —— 全站唯一一次出现是解绑时把它清成 null，从来没写进过值",
  },
  {
    column: "bind_codes.attempts",
    disposition: "superseded",
    why: "设计变了：验证码是用户发给机器人的，站内没有「输入验证码」这一步，也就没有可爆破的地方。防滥用挡在发码那一侧（每 IP 每天限次）",
  },

  /* ── 论坛 ────────────────────────────────────────────────── */
  {
    column: "forum_post_sources.converted_at",
    disposition: "planned",
    why: "**这条我先前判错过**：一开始写的是「和帖子的 created_at 重复」，而这张表根本没有 created_at —— 它是转帖这件事自己的时间戳，每次转帖都写。留着：帖子会被编辑、移版块，而「这次转帖发生在什么时候」是一个独立的事实。缺的是读它的地方（转帖来源那一栏该显示它）",
  },

  /* ── 邀请 / 角色 ─────────────────────────────────────────── */
  {
    column: "invites.grant_role_id",
    disposition: "planned",
    why: "「这个邀请码进来的人自动带某个角色」是想做的，但创建邀请码的界面没有这一项，写入路径也没有。半截接上去比没有更危险 —— 管理员会以为设了",
  },
  {
    column: "roles.badge_style",
    disposition: "planned",
    why: "角色徽章现在只有颜色。样式（描边 / 渐变 / 图标）没做",
  },

  /* ── 上游同步 ────────────────────────────────────────────── */
  {
    column: "group_members.is_admin",
    disposition: "planned",
    why: "上游接口目前不告诉我们谁是群管理员。拿不到就不写，写个恒为 false 的列比空着更容易被误信",
  },
  {
    column: "sync_cursors.last_id",
    disposition: "superseded",
    why: "增量同步按时间游标推进，不按 id —— 上游的 id 不保证单调",
  },

  /* ── 活动 ────────────────────────────────────────────────── */
  {
    column: "activities.rules_md",
    disposition: "planned",
    why: "活动的详细规则正文。现在只有一段简介，长规则没地方放",
  },
  {
    column: "activities.waitlist_cap",
    disposition: "planned",
    why: "候补名单没做 —— 现在满了就是满了",
  },
  {
    column: "activities.fulfill_deadline",
    disposition: "planned",
    why: "兑现截止时间。发奖那一段还没做",
  },
  {
    column: "activities.result_public",
    disposition: "planned",
    why: "结果公示的开关。公示页面还没做",
  },
  {
    column: "activity_applications.retry_of",
    disposition: "planned",
    why: "「这次申请是上次被拒之后重投的」。重投链路没做，撤回后重填走的是改同一行",
  },
];
