/**
 * 注销账号时，每一张表怎么处理。
 *
 * ─────────────────────────────────────────
 * 先分清两个身份空间
 * ─────────────────────────────────────────
 *
 * 库里有 64 张表引用「人」，而它们分属两套 id：
 *
 *   · `user_id` —— **站内账号**。这是注销要删掉的东西。
 *   · `wx_id`   —— **微信身份**。群聊归档、榜单、日统计都按它记。
 *
 * 第二套**不能删，也删不掉**：`messages` 是从上游同步下来的镜像，
 * 删掉的行下一轮同步会原样回来 —— 既破坏归档，又白费力气。
 * 而且那些消息是**群的记录**，不是这个站的：一个人退出这个网站，
 * 不等于他能把三个月前群里那场讨论从别人的记忆里删掉。
 *
 * 这件事必须在用户按下确认**之前**说清楚。不说的话，
 * 他会以为注销能删掉自己的微信发言 —— 那是这个功能最坏的误解，
 * 因为等他发现时已经没有账号可以登回来问了。
 *
 * ─────────────────────────────────────────
 * 为什么做成一张登记表，而不是一串 DELETE
 * ─────────────────────────────────────────
 *
 * 写成一串 DELETE 的话，**新加的表不会有任何提示**。
 * 半年后某个新功能建了张带 user_id 的表，注销时它就被漏下了 ——
 * 一个注销过的人，痕迹还留在库里，而没有任何地方看得出来。
 *
 * 所以每一张引用「人」的表都必须在这里有一条明确处置，
 * 由 `tests/deletion-plan.test.ts` 从 schema 里扫出全部表逐一比对：
 * **漏一张，测试就红**。这和 DEAD_COLUMNS 是同一套办法。
 */

export type Disposition =
  /** 删掉。纯粹属于这个账号的痕迹，留着没有任何人受益 */
  | "purge"
  /** 内容留下，作者抹成「已注销」。删掉会毁掉别人的对话 */
  | "anonymize"
  /** 留着不动。审计与账目 —— 它们的价值恰恰在于不能被当事人抹掉 */
  | "keep"
  /** 不属于这个账号：微信身份那一侧，群的记录 */
  | "wx-space";

export interface TablePlan {
  table: string;
  disposition: Disposition;
  why: string;
  /**
   * 这张表不直接写「人」，而是**挂在另一张表下面**。
   *
   * `keyword_hits` 只有 `sub_id` —— 它属于哪个人，要顺着
   * `keyword_subs` 才问得出来。这类表同样必须清，
   * 但「扫 schema 找带 user_id 的表」那一套发现不了它们，
   * 所以要显式写出挂在谁下面。
   */
  via?: { table: string; column: string };
}

export const DELETION_PLAN: readonly TablePlan[] = [
  /* ── 微信身份那一侧：一个字都不动 ─────────────────── */
  {
    table: "messages",
    disposition: "wx-space",
    why: "上游镜像。删了下一轮同步原样回来 —— 既破坏归档又白费力气。而且它是群的记录，不是这个站的",
  },
  { table: "message_mentions", disposition: "wx-space", why: "「谁在群里被 @ 了」按 wx_id 记，跟着消息一起来自上游。删了下轮同步照样回来" },
  { table: "daily_stats", disposition: "wx-space", why: "按 wx_id 记的群活跃统计。删掉会让群的历史曲线凭空缺一块，而那不是这个账号的东西" },
  { table: "people", disposition: "wx-space", why: "群成员档案，来自上游同步。这个人还在群里，只是不再用这个网站" },
  { table: "group_members", disposition: "wx-space", why: "谁在哪个群由上游说了算。注销站内账号不等于退群 —— 这个人还在微信群里，删了下轮同步照样回来" },
  { table: "group_member_events", disposition: "wx-space", why: "进群、退群、改名的事件流，来自上游。它记的是微信那一侧发生的事，和站内账号无关" },
  { table: "season_standings", disposition: "wx-space", why: "赛季名次按 wx_id 结算。抹掉会让当季名次凭空空一格，而名次是公开过的事实" },
  { table: "link_mentions", disposition: "wx-space", why: "「谁在群里贴过这个链接」按 wx_id 记，属于群聊那一侧" },
  {
    table: "person_phrases",
    disposition: "wx-space",
    why:
      "「常挂在嘴边」是从群消息里归纳出来的，按 wx_id 存。" +
      "它跟着消息走：注销站内账号不等于退群，那些消息还在，下一轮定时任务照样会重算出来。" +
      "**但注销之后它对别人就不再显示了** —— 主页那一栏走的是 unsearchableWxIds，" +
      "而没有账号的人本来就不在成员目录里。真要抹掉，得连群消息一起删",
  },
  { table: "join_requests", disposition: "wx-space", why: "按 wx_id 记的入群申请。它记录的是「这个微信号申请过」，和站内账号不是一回事" },

  /* ── 纯属这个账号的痕迹：删 ───────────────────────── */
  {
    table: "api_tokens",
    disposition: "purge",
    why:
      "开放 API 的令牌。和登录凭证同一个道理：账号都没了还留着一把能替他做事的钥匙，" +
      "只剩下风险 —— 而且这些钥匙里有的能往群里发消息",
  },
  {
    table: "group_send_grants",
    disposition: "purge",
    why:
      "「他可以往某个群发消息」的授权。账号没了，这条授权就没有对象了；" +
      "留着的话，哪天有人复用同一个 user_id 就会凭空继承一个发送权限",
  },
  {
    table: "api_sends",
    disposition: "anonymize",
    why:
      "通过 API 代发的消息记录。**不能直接删** —— 那些消息已经出现在群里了，" +
      "而且每一条都带着「本消息由某某代发」的署名，群里的人看得见。" +
      "删掉记录不会让消息消失，只会让「这条到底是谁让机器人说的」永远答不上来。" +
      "所以抹掉 user_id/token_id，正文和时间留下",
  },
  { table: "credentials", disposition: "purge", why: "登录凭证（密码哈希、Passkey）。账号都没了还留着凭证，只剩下风险，没有任何用处" },
  { table: "sessions", disposition: "purge", why: "会话。必须删，否则注销之后旧 cookie 还能进来" },
  { table: "login_attempts", disposition: "purge", why: "登录尝试记录。它是给风控看「这个账号最近被试了多少次」的，账号没了就没有对象了" },
  { table: "bind_codes", disposition: "purge", why: "绑定验证码。短期凭证，留着既没用又是一条能被翻出来的线索" },
  { table: "webauthn_challenges", disposition: "purge", why: "Passkey 的一次性挑战值。用过即弃，账号没了更没有留的理由" },
  { table: "push_subscriptions", disposition: "purge", why: "推送端点。不删的话会继续往他的设备推通知 —— 账号都注销了还在响，是最刺眼的那种残留" },
  { table: "keyword_subs", disposition: "purge", why: "他自己设的关键词雷达。不删的话，同步那一侧会继续为一个注销了的账号匹配和记录命中" },
  {
    table: "keyword_hits",
    disposition: "purge",
    why: "雷达命中记录。它只有 sub_id、不直接写人，所以自动扫描发现不了它 —— 而订阅删了之后留着一堆孤儿命中，既没人看得到也永远清不掉",
    via: { table: "keyword_subs", column: "sub_id" },
  },
  { table: "notification_prefs", disposition: "purge", why: "他自己调的通知偏好。账号没了，这些设置没有任何对象可以生效" },
  { table: "notifications", disposition: "purge", why: "收件箱。只有他自己看得到，留着没有任何人受益" },
  { table: "user_privacy", disposition: "purge", why: "隐私开关。账号没了，开关也没有对象了" },
  { table: "github_connections", disposition: "purge", why: "**带 access token**，最该删干净的一张" },
  { table: "github_repo_cache", disposition: "purge", why: "他 GitHub 仓库列表的缓存。绑定都删了，缓存留着只是一份过期的个人资料" },
  { table: "github_share_prompts", disposition: "purge", why: "他准备分享到站里的仓库/PR 草稿。没发出来的东西，别人从来没看过" },
  { table: "user_skills", disposition: "purge", why: "技能标签，成员目录用。人不在目录里了，标签也没了对象" },
  { table: "forum_drafts", disposition: "purge", why: "没发出来的草稿。从来没有别人看过，删掉不影响任何人" },
  { table: "forum_bookmarks", disposition: "purge", why: "他的收藏。只有他自己看得到，留着没有任何人受益" },
  { table: "forum_bookmark_folders", disposition: "purge", why: "收藏夹，跟着收藏一起走 —— 留着就是一堆空文件夹挂在一个不存在的人名下" },
  { table: "forum_subscriptions", disposition: "purge", why: "他订阅的版块和帖子。不删的话，通知那一侧还会继续为一个注销了的账号算新内容" },
  { table: "forum_post_views", disposition: "purge", why: "阅读记录。这是最私密的一类痕迹 —— 「他看过哪些帖子」" },
  { table: "forum_reactions", disposition: "purge", why: "他点的赞。计数是从明细重算的，删掉之后自动对得上" },
  { table: "forum_poll_votes", disposition: "purge", why: "他投过的票。票数是从明细重算的，删掉之后自动对得上 —— 而一个注销了的人还占着一票，投票结果就不再是「现在还在的人怎么想」" },
  { table: "link_votes", disposition: "purge", why: "资源库点赞。计数是从明细重算的，删掉之后自动对得上" },
  { table: "link_saves", disposition: "purge", why: "资源库收藏。同样只有他自己看得到" },
  { table: "announcement_dismissals", disposition: "purge", why: "「这条公告我已读」。纯粹的个人阅读状态，对别人没有任何意义" },
  { table: "data_exports", disposition: "purge", why: "他自己导出过几次。导出文件本身不在库里" },
  { table: "uploads", disposition: "purge", why: "他上传的文件记录。注意文件本体在磁盘上，要跟着一起清 —— 只删库里的行会留下一批谁也认领不了的文件" },
  { table: "makeup_cards", disposition: "purge", why: "补签卡是挂在他名下的道具，和称号一样 —— 人不在了就不在了" },
  {
    table: "checkins",
    disposition: "purge",
    why:
      "打卡记录。连胜、补签这些都是**他一个人的**进度，别人看不到也用不上。" +
      "对应的积分已经落在 points_ledger 里（那一张是 keep），所以删掉不影响账",
  },
  { table: "user_roles", disposition: "purge", why: "角色授予。账号没了，权限必须跟着没 —— 留着是最危险的一种残留" },
  { table: "permission_overrides", disposition: "purge", why: "权限例外。和角色一样必须跟着账号消失，留着是最危险的一种残留" },
  { table: "user_titles", disposition: "purge", why: "他获得的称号。称号是挂在人身上的，人不在了就不在了" },
  { table: "activity_applications", disposition: "purge", why: "活动报名。人不在了，名额该退回去" },
  { table: "user_notes", disposition: "purge", why: "管理员给他写的备注。对象没了，备注只剩下一个孤立的人物评价挂在库里" },

  /* ── 邮箱 ────────────────────────────────────────────
   *
   * 这一组比别处急：邮箱里躺着的是**验证码和找回密码的链接**。
   * 一个注销过的账号，如果它的地址还活着、还在收信，
   * 那些信会一直落在一个没有主人的箱子里。
   */
  {
    table: "mail_boxes",
    disposition: "purge",
    why: "他的邮箱地址。删掉之后地址回到池子里可以重新发出去 —— 留着的话，那个地址会一直收信而没有任何人看得到",
  },
  /*
   * ⚠ **深的先删**。执行器按登记表里的顺序走挂靠表，
   * 附件挂在邮件下面 —— 邮件先被删掉的话，
   * `WHERE message_id IN (SELECT id FROM mail_messages …)` 查出来是空的，
   * 附件成了永远清不掉的孤儿，而且不报错。
   * （`keyword_hits` 那一条的注释里记着同一个坑，那次是订阅先删。）
   */
  {
    table: "mail_attachments",
    disposition: "purge",
    why: "附件元信息与落盘的文件，跟着邮件走",
    via: { table: "mail_messages", column: "message_id" },
  },
  {
    table: "mail_messages",
    disposition: "purge",
    why: "收到的信。里面是验证码和找回密码的链接，注销之后一秒都不该多留",
    via: { table: "mail_boxes", column: "box_id" },
  },
  {
    table: "mail_slots",
    disposition: "purge",
    why: "他的邮箱槽位。人不在了，额度该收回去",
  },
  {
    table: "mail_domains",
    disposition: "keep",
    /*
     * 域名不删，只把 owner_user_id 清空 —— 域名是站里买的资产，
     * 不是这个账号的东西。删掉的话，那 100 个域名会因为
     * 一个人注销而少一个，而没有任何地方看得出来它去哪了。
     */
    why: "域名本身是站里买的资产，不跟着账号走。注销时把 owner_user_id 清空，域名回到未分配状态",
  },
  {
    table: "mail_events",
    disposition: "keep",
    why: "「这个地址是谁开的、什么时候被收回的」—— 和审计日志同一个道理：它的价值恰恰在于不能被当事人抹掉",
  },
  {
    table: "mail_banwords",
    disposition: "keep",
    why: "它只带 created_by（是哪个管理员加的），不是这个人的数据。删掉的话，禁用词会随着某个管理员注销而消失 —— 那正是它要挡的东西重新可用的时刻",
  },
  {
    table: "mail_blocks",
    disposition: "keep",
    why: "发件人黑名单，同 mail_banwords —— created_by 是操作者不是所有者",
  },

  /* ── 内容留下，作者抹掉 ───────────────────────────── */
  {
    table: "forum_posts",
    disposition: "anonymize",
    why:
      "删帖会**毁掉别人的对话** —— 一个引发了三十条回复的帖子消失之后，" +
      "那三十条就成了自言自语。所以正文留下，作者抹成「已注销」。" +
      "这一条要在确认页上说明白：他删的是账号，不是已经参与过的公共讨论",
  },
  { table: "forum_replies", disposition: "anonymize", why: "同上。一条被人引用过的回复删掉，上下文就断了" },
  { table: "forum_tips", disposition: "anonymize", why: "打赏流水。金额与去向要留（那是别人收到的积分），谁给的可以抹" },

  /* ── 审计与账目：留着不动 ─────────────────────────── */
  {
    table: "audit_logs",
    disposition: "keep",
    why:
      "审计日志**必须扛得住当事人自己抹掉**，否则它就不是审计。" +
      "一个管理员做了事再注销账号，记录跟着消失 —— 那正是审计要防的情形",
  },
  { table: "moderation_actions", disposition: "keep", why: "处罚记录。同上，执行者能抹掉自己的处罚记录的话，申诉就没法查了" },
  { table: "forum_visibility_audit", disposition: "keep", why: "谁把哪篇帖子的可见性改了 —— 这是群聊转帖那条硬约束的凭证" },
  { table: "points_ledger", disposition: "keep", why: "积分流水是**账**。抹掉一个人的流水，全站总额就对不上了，而对不上没有任何地方看得出来" },
  { table: "points_anomalies", disposition: "keep", why: "风控记录。可以被注销抹掉的风控等于没有风控" },
  { table: "orders", disposition: "keep", why: "订单。已经发生的兑换是事实，而且商品那一侧的库存是按订单算的" },
  { table: "reports", disposition: "keep", why: "举报记录。举报人注销就让举报消失的话，被举报的人只要等一等就好了" },
  { table: "appeals", disposition: "keep", why: "申诉记录。和处罚记录成对，只留一半的话，后来的人只看得到处罚看不到申辩" },
  { table: "invite_uses", disposition: "keep", why: "邀请关系。「一个人只能被邀请一次」这条规则靠它，删掉就能注销重注册反复领奖励" },
  { table: "activity_events", disposition: "keep", why: "活动事件流。主办方要对得上账 —— 谁报名、谁签到、谁退出，少一条就查不清了" },

  /* ── 管理员建的东西：留着，作者引用不动 ────────────── */
  { table: "activities", disposition: "keep", why: "他办过的活动。活动本身属于社区，办活动的人走了活动不该消失" },
  { table: "broadcasts", disposition: "keep", why: "已经发出去的群发。发出去的话收不回来，记录也一样" },
  { table: "forum_boards", disposition: "keep", why: "版块。建版块的人走了，版块还在，里面还挂着别人的帖子" },
  { table: "forum_tags", disposition: "keep", why: "标签。建标签的人走了，标签还挂在一堆帖子上" },
  { table: "shop_items", disposition: "keep", why: "商品。上架的人走了不代表商品下架 —— 而且已有订单指着它" },
  { table: "titles", disposition: "keep", why: "称号的定义（不是「谁拿到了」那张表）。别人身上还挂着这些称号" },
  { table: "roles", disposition: "keep", why: "角色定义（不是谁有这个角色）。建角色的人走了，角色还在 —— 别人还挂着它" },
  { table: "sensitive_words", disposition: "keep", why: "敏感词表。添词的人走了，词还得继续拦" },
  { table: "invites", disposition: "keep", why: "邀请码。已经发出去的码不该因为发码人注销而失效" },
  { table: "admin_tasks", disposition: "keep", why: "后台待办。派活的人走了，活还在那儿等人干" },

  /* ── 账号本身 ─────────────────────────────────────── */
  {
    table: "users",
    disposition: "anonymize",
    why:
      "**行留着，内容抹空**。删行的话，所有 keep 那一档里的 user_id 都成了" +
      "指向虚空的外键 —— 审计日志翻出来是一串查不到人的 id。" +
      "留一行标着 deleted 的壳，那些引用才有落点，" +
      "而昵称、头像、微信号这些**能认出是谁**的字段全部清掉",
  },
];

const BY_TABLE = new Map(DELETION_PLAN.map((p) => [p.table, p]));

export function planFor(table: string): TablePlan | undefined {
  return BY_TABLE.get(table);
}

export const PURGE_TABLES = DELETION_PLAN.filter((p) => p.disposition === "purge").map(
  (p) => p.table,
);

/**
 * 注销确认要手打的那个词。
 *
 * 放在这里而不是 `delete-actions.ts` —— 那个文件带 `"use server"`，
 * 而**「use server」文件只允许导出 async 函数**：导出一个常量会让
 * 整个构建失败（而且报的是「该模块没有任何导出」，第一眼看不出原因）。
 *
 * 放这里也更顺：这个文件本来就是「注销这件事的规矩」，
 * 服务端动作和界面都从这儿取，不会有第二份。
 */
export const CONFIRM_WORD = "注销我的账号";

/**
 * 确认页上必须说清楚的三件事。
 *
 * 单独放在这里、并由测试盯着**每一条都出现在界面上** ——
 * 因为这三件事一旦没说，用户的理解和实际发生的事就是错位的，
 * 而他发现错位的时候已经没有账号可以登回来问了。
 */
export const MUST_DISCLOSE = [
  {
    key: "chat-stays",
    text: "群聊记录不会删除",
    detail:
      "你在微信群里说过的话是群的记录，从上游同步过来 —— 这个站删不掉，" +
      "删了下次同步也会回来。要撤回群里的消息，请在微信里操作。",
  },
  {
    key: "posts-anonymized",
    text: "已发的帖子和回复会留下，但不再显示你的名字",
    detail:
      "直接删掉会毁掉别人的对话：一个引发了三十条回复的帖子消失之后，" +
      "那三十条就成了自言自语。所以正文留下，作者显示为「已注销」。",
  },
  {
    key: "irreversible",
    text: "这件事不可撤销",
    detail: "账号、登录方式、积分、称号、收藏、草稿都会消失，且无法恢复。重新绑定等于一个全新的账号。",
  },
] as const;
