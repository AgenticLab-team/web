import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  FOLLOW_TARGETS,
  MAX_FOLLOWS,
  canFollow,
  canSeeFollowList,
  noticeCopy,
  pickSource,
} from "@/lib/forum/follow-rules";
import { tabBarItems } from "@/lib/nav";
import { stripComments as strip } from "./_source";

/**
 * 关注作者 / 版块 / 标签。
 *
 * ─────────────────────────────────────────
 * 四个值的枚举，只有一个值出现过
 * ─────────────────────────────────────────
 *
 * `subscriptions.target_type` 一开始就写着 `post | board | tag | user`，
 * 而全站只写过也只读过 `post` —— 生产库里 34 行订阅，全是 post。
 *
 * 更要紧的是：**发新帖这件事根本不发通知**。站里只有
 * `notifyNewReply`，没有 `notifyNewPost`。也就是说「关注」
 * 在这个站里目前只有一个意思：「这个帖子有人回复时叫我」。
 *
 * ─────────────────────────────────────────
 * 新帖扇出是一条会绕过可见性的路
 * ─────────────────────────────────────────
 *
 * 这条通知带着**标题**和链接，发给的是订阅者 —— 而订阅者
 * 不等于有权看的人。这一组测试大半在测这一件事。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

describe("能不能关注", () => {
  it("正常的能", () => {
    assert.equal(canFollow({ target: "user", current: 0 }).ok, true);
  });

  it("**不能关注自己** —— 自己发的帖不会给自己发通知，关了也是个死开关", () => {
    const r = canFollow({ target: "user", current: 0, isSelf: true });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /不用关注自己/);
  });

  it("有上限，而且说清楚为什么", () => {
    /*
     * 不是怕存不下，是怕收件箱变成一条什么都在里面的河 ——
     * 「有人找你」和「有人发帖」混在一起之后，人会把整页都关掉。
     */
    const r = canFollow({ target: "user", current: MAX_FOLLOWS.user });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /通知/);
  });

  it("三种目标各有各的上限，版块的最小", () => {
    // 版块的扇出量最大 —— 一个版块的新帖比一个人的多得多
    assert.ok(MAX_FOLLOWS.board < MAX_FOLLOWS.user);
    for (const t of FOLLOW_TARGETS) assert.ok(MAX_FOLLOWS[t] > 0);
  });
});

describe("**一个人只收到一条**", () => {
  it("同时命中多种时，越具体的越优先", () => {
    /*
     * 关注了张三、又关注了他常去的版块，他发一个帖 ——
     * 不去重就是两条一模一样的通知，而收到两条的人第一反应是这个站坏了。
     */
    assert.equal(pickSource(["board", "user"]), "user");
    assert.equal(pickSource(["board", "tag"]), "tag");
    assert.equal(pickSource(["board"]), "board");
    assert.equal(pickSource([]), null);
  });

  it("措辞按来源变，作者那一路说得最具体", () => {
    const byUser = noticeCopy({ source: "user", sourceId: "u1", sourceName: "张三", authorName: "张三" });
    assert.match(byUser.title, /张三/);

    const byBoard = noticeCopy({ source: "board", sourceId: "b1", sourceName: "综合讨论", authorName: "张三" });
    assert.match(byBoard.title, /综合讨论/);
  });

  it("**合并后的措辞要成句** —— 通用那套会写出「某人等 2 人综合讨论有新帖」", () => {
    /*
     * 通用合并写法是「张三等 3 人回复了你的帖子」，它假设标题以人名开头。
     * 这里两种都不成立：
     *
     * · 版块那一路的标题是「综合讨论有新帖」，套上去不成句
     * · 作者那一路更糟 —— groupKey 按作者分，合并的永远是同一个人，
     *   而「张三等 2 人」在说有两个人发了帖
     */
    const byUser = noticeCopy({ source: "user", sourceId: "u1", sourceName: "张三", authorName: "张三" });
    assert.equal(byUser.aggregate(3), "张三发了 3 个新帖");
    assert.doesNotMatch(byUser.aggregate(3), /等 3 人/);

    const byBoard = noticeCopy({ source: "board", sourceId: "b1", sourceName: "综合讨论", authorName: "张三" });
    assert.equal(byBoard.aggregate(2), "综合讨论有 2 个新帖");
    // 一个版块里的多条新帖通常来自不同的人，不该指名道姓
    assert.doesNotMatch(byBoard.aggregate(2), /张三/);
  });

  it("**groupKey 按来源分，不按帖子分**", () => {
    /*
     * 按帖子分的话，一个活跃版块一天十条新帖就是十条通知；
     * 按来源分是一条「综合讨论有 10 个新帖」。
     * 前者会让人关掉这一类，然后连关注的人发帖也收不到。
     */
    const a = noticeCopy({ source: "board", sourceId: "b1", sourceName: "综合", authorName: null });
    const b = noticeCopy({ source: "board", sourceId: "b1", sourceName: "综合", authorName: null });
    assert.equal(a.groupKey, b.groupKey);
    assert.match(a.groupKey, /b1/);
  });
});

describe("取消关注是真的删掉", () => {
  it("三种目标都是删，不是静音", () => {
    /*
     * 帖子订阅用静音，因为发帖回帖会自动订阅回来 —— 删掉的话
     * 退订按钮下一次回帖就失效了。关注只有手动一条路进来，
     * 留一行「已静音」只会让列表里堆着自己已经取消的东西。
     */
    const actions = strip(src("lib/forum/follow-actions.ts"));
    assert.match(actions, /db\.delete\(subscriptions\)/);
    assert.doesNotMatch(actions, /mutedAt: Date\.now\(\)/);
  });
});

describe("**关注是私密的**", () => {
  it("只有本人看得到自己的关注列表", () => {
    assert.equal(canSeeFollowList("u1", "u1"), true);
    assert.equal(canSeeFollowList("u2", "u1"), false);
    assert.equal(canSeeFollowList(null, "u1"), false);
  });

  it("**查询层没有「看某某关注了谁」这种签名** —— 没有签名就没人会不小心调出来", () => {
    const code = src("lib/forum/follow.ts");
    for (const fn of ["listFollows", "followCount", "isFollowing"]) {
      const at = code.indexOf(`export function ${fn}`);
      assert.ok(at > 0, `${fn} 不见了`);
      // 第一个参数一律是 userId：本人
      assert.match(code.slice(at, at + 120), /\(\s*userId: string/, `${fn} 的第一个参数不是 userId`);
    }
    assert.doesNotMatch(code, /followersOf|listFollowers/);
  });

  it("**不给被关注的人发通知** —— 那条通知泄露的正是关注列表想保护的东西", () => {
    const actions = strip(src("lib/forum/follow-actions.ts"));
    assert.doesNotMatch(actions, /notify\(/);
  });

  it("按钮上不显示关注数 —— 那是关注列表的聚合视图", () => {
    const button = strip(src("components/forum/FollowButton.tsx"));
    assert.doesNotMatch(button, /followerCount|人关注/);
  });
});

describe("界面", () => {
  it("按钮上的字说的是**状态**，不是点下去会发生什么", () => {
    /*
     * 写「取消关注」的话，一个没关注的人会以为自己已经关注了。
     * 动作放在 title / aria-label 里。
     */
    const button = src("components/forum/FollowButton.tsx");
    assert.match(button, /\{on \? "已关注" : "关注"\}/);
    assert.match(button, /aria-pressed=\{on\}/);
  });

  it("版块页和成员页都有入口", () => {
    assert.match(src("app/(app)/forum/[board]/page.tsx"), /<FollowButton target="board"/);
    assert.match(src("app/(app)/members/[wxId]/page.tsx"), /<FollowButton target="user"/);
  });

  it("**没有站内账号的人不给关注按钮** —— 点了永远不会有动静", () => {
    /*
     * 关注的意思是「他发新帖时叫我」，而发帖需要账号。
     * 只在群里说话、没注册过的人挂一个关注按钮就是个死开关。
     */
    const page = strip(src("app/(app)/members/[wxId]/page.tsx"));
    assert.match(page, /const canFollowThem = Boolean\(account\)/);
  });

  /*
   * ─────────────────────────────────────────
   * 「我关注的」并进了「我的」
   * ─────────────────────────────────────────
   *
   * 这一条原来断言的是 nav.ts 里有 `key: "following"`。它当初存在的理由
   * （写在 bookmarks/drafts 那两条同款断言旁边）是：
   * **「新功能只在电脑端侧栏加入口」是这个站反复犯的错**，
   * 所以要求入口必须进 NAV —— 因为 NAV 是两端唯一的真源。
   *
   * 现在它不再是一个独立的导航项，而是「我的」页面上的一行。
   * 那条理由**没有被绕过**：「我的」本身在 NAV 里、而且在 tab 栏里，
   * 手机和电脑打开的是同一个页面、同一行。
   *
   * 所以这里断言的东西换成三件，比原来那条更严：
   *   ① 它真的从导航里撤了（否则「合并」只是嘴上说说，侧栏照样十几行）
   *   ② 「我的」页面上确实有这一行（不然就是删掉了，不是合并）
   *   ③ 「我的」还在 tab 栏里（否则合并进去等于藏起来）
   */
  it("入口并进了「我的」—— 手机和电脑打开的是同一页同一行", () => {
    const nav = src("lib/nav.ts");
    assert.doesNotMatch(nav, /key: "following"/, "还在导航里单列着，没有并进「我的」");

    assert.match(src("app/(app)/me/page.tsx"), /href="\/me\/following"/, "「我的」页上没有这一行");

    const inTabBar = tabBarItems(() => true).map((i) => i.key);
    assert.ok(inTabBar.includes("me"), "「我的」不在 tab 栏里，关注就等于在手机上被藏起来了");
  });

  it("**旧地址不能死** —— 通知和历史链接都指着 /me/following", () => {
    /*
     * 关注列表从导航里撤下来了，但页面必须留着：
     * 站内通知、别人转发过的链接、浏览器历史里都存着这个地址，
     * 而一个 404 在用户那边读起来是「这个功能没了」。
     */
    const page = readFileSync(
      new URL("../src/app/(app)/me/following/page.tsx", import.meta.url),
      "utf8",
    );
    assert.match(page, /export default async function/);
    // 撤下导航之后，返回键是回到「我的」唯一的路
    assert.match(page, /<BackLink href="\/me">/);
  });

  it("已经没了的关注也留着能删，不悄悄滤掉", () => {
    /*
     * 悄悄滤掉的话，关注数和列表条数对不上，而没有任何地方说明为什么。
     */
    const list = src("components/forum/FollowList.tsx");
    assert.match(list, /item\.gone/);
    assert.match(strip(list), /unfollowById\(item\.id\)/);
  });

  it("通知设置里能单独关掉这一类", () => {
    const prefs = src("lib/notifications/prefs.ts");
    assert.match(prefs, /type: "new_post"/);
    assert.match(prefs, /following: "你关注的"/);
  });

  it("**new_post 的推送默认关** —— 关注一个活跃版块就是每天十几条打到锁屏上", () => {
    const prefs = src("lib/notifications/prefs.ts");
    assert.match(prefs, /PUSH_OFF_BY_DEFAULT[^\n]*"reaction", "new_post"/);
  });

  it("规则层不碰数据库", () => {
    const code = src("lib/forum/follow-rules.ts");
    for (const forbidden of ["server-only", "@/lib/db", "drizzle-orm"]) {
      assert.equal(code.includes(forbidden), false, `规则层引了 ${forbidden}`);
    }
  });

  it("用 SVG 图标不用 emoji", () => {
    for (const f of ["components/forum/FollowButton.tsx", "components/forum/FollowList.tsx"]) {
      assert.match(src(f), /lucide-react/);
      assert.doesNotMatch(strip(src(f)), /[\u{1F300}-\u{1FAFF}]/u);
    }
  });
});

/* ───────────────────────────────────────────────────────────────
 * 扇出要真数据库：可见性和匿名都只在有真帖子时才测得出来
 * ─────────────────────────────────────────────────────────────── */

const tmp = mkdtempSync(join(tmpdir(), "al-follow-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

let dbm: typeof import("@/lib/db");
let schema: typeof import("@/lib/db/schema");
let notify: typeof import("@/lib/forum/notify");

const BOARD = "b_general";
const AUTHOR = "u_author";

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  notify = await import("@/lib/forum/notify");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  for (const t of [schema.notifications, schema.subscriptions, schema.posts, schema.boards, schema.users]) {
    dbm.db.delete(t).run();
  }
  dbm.db
    .insert(schema.boards)
    .values({ id: BOARD, key: "general", name: "综合讨论", sort: 0 })
    .run();
  dbm.db
    .insert(schema.users)
    .values({ id: AUTHOR, wxId: "wx_author", siteNickname: "张三", status: "active" })
    .run();
});

function follower(id: string, over: Partial<typeof schema.users.$inferInsert> = {}) {
  dbm.db.insert(schema.users).values({ id, wxId: `wx_${id}`, status: "active", ...over }).run();
  return id;
}

function follows(userId: string, target: "user" | "board" | "tag", targetId: string) {
  dbm.db
    .insert(schema.subscriptions)
    .values({ userId, targetType: target, targetId, auto: false })
    .run();
}

let seq = 0;

function post(over: Partial<typeof schema.posts.$inferInsert> = {}) {
  /*
   * id 必须是**真正写进去的那个**。
   *
   * 第一版这里算了个 id、又让 `...over` 覆盖它，然后 return 了算出来的那个 ——
   * 于是 notifyNewPost 拿着一个不存在的 id 查不到帖子，直接返回。
   * 「草稿不扇出」那条因此是绿的，而它什么都没验证。
   */
  const id = (over.id as string | undefined) ?? `p${++seq}`;
  dbm.db
    .insert(schema.posts)
    .values({
      ...over,
      id,
      boardId: BOARD,
      authorId: AUTHOR,
      title: over.title ?? "一个标题",
      content: "正文",
      contentHtml: "<p>正文</p>",
      status: over.status ?? "published",
      visibility: over.visibility ?? "public",
    })
    .run();
  return id;
}

function fanOut(postId: string) {
  notify.notifyNewPost({
    postId,
    title: "一个标题",
    authorId: AUTHOR,
    authorName: "张三",
    boardId: BOARD,
    boardName: "综合讨论",
  });
}

const inboxOf = (userId: string) =>
  dbm.db.select().from(schema.notifications).where(eq(schema.notifications.userId, userId)).all();

let eq: typeof import("drizzle-orm").eq;
before(async () => {
  ({ eq } = await import("drizzle-orm"));
});

describe("**新帖扇出**", () => {
  it("关注作者的人收得到", () => {
    const u = follower("u_fan");
    follows(u, "user", AUTHOR);
    fanOut(post());
    assert.equal(inboxOf(u).length, 1);
    assert.match(inboxOf(u)[0].title, /张三/);
  });

  it("关注版块的人收得到", () => {
    const u = follower("u_fan");
    follows(u, "board", BOARD);
    fanOut(post());
    assert.match(inboxOf(u)[0].title, /综合讨论/);
  });

  it("**同时关注作者和版块只收一条**", () => {
    const u = follower("u_fan");
    follows(u, "user", AUTHOR);
    follows(u, "board", BOARD);
    fanOut(post());
    const inbox = inboxOf(u);
    assert.equal(inbox.length, 1, "发了两条");
    assert.match(inbox[0].title, /张三/, "该用更具体的那一路措辞");
  });

  it("不通知作者自己", () => {
    follows(AUTHOR, "board", BOARD);
    fanOut(post());
    assert.equal(inboxOf(AUTHOR).length, 0);
  });

  it("没人关注时什么都不发", () => {
    fanOut(post());
    assert.equal(dbm.db.select().from(schema.notifications).all().length, 0);
  });
});

describe("**逐人判可见性 —— 这条通知本身就是泄露**", () => {
  it("看不到那个帖子的人收不到通知", () => {
    /*
     * 这条通知带着标题和链接。少了这一步，一个「仅自己可见」
     * 的帖子标题就会出现在所有粉丝的通知栏里 ——
     * 点不点进去都一样，通知本身已经泄露了。
     */
    const u = follower("u_fan");
    follows(u, "user", AUTHOR);
    fanOut(post({ visibility: "private" }));
    assert.equal(inboxOf(u).length, 0, "私密帖的标题发给了粉丝");
  });

  it("限定身份的帖子只发给有那个身份的人", () => {
    const withRole = follower("u_has");
    const without = follower("u_hasnt");
    follows(withRole, "user", AUTHOR);
    follows(without, "user", AUTHOR);

    dbm.db.insert(schema.roles).values({ id: "r1", key: "vip", name: "VIP" }).run();
    dbm.db.insert(schema.userRoles).values({ userId: withRole, roleId: "r1" }).run();

    fanOut(post({ visibility: "role", visibilityRoleId: "r1" }));

    assert.equal(inboxOf(withRole).length, 1);
    assert.equal(inboxOf(without).length, 0, "没有那个身份的人收到了");
  });

  it("草稿和已删的不扇出 —— 只有真的发出来了才算发生过", () => {
    const u = follower("u_fan");
    follows(u, "user", AUTHOR);

    fanOut(post({ id: "p_draft", status: "draft" }));
    assert.equal(inboxOf(u).length, 0, "草稿扇出去了");

    fanOut(post({ id: "p_del", deletedAt: Date.now() }));
    assert.equal(inboxOf(u).length, 0, "已删的扇出去了");
  });

  it("已经不能登录的人不再收通知", () => {
    const banned = follower("u_banned", { status: "banned" });
    follows(banned, "board", BOARD);
    fanOut(post());
    assert.equal(inboxOf(banned).length, 0);
  });
});

describe("**匿名帖不能反推作者**", () => {
  it("按作者关注的那一路整个跳过", () => {
    /*
     * 收件人名单本身就是答案：「你关注的张三发了新帖」
     * + 一个匿名帖的链接 = 匿名当场失效。
     */
    const u = follower("u_fan");
    follows(u, "user", AUTHOR);
    fanOut(post({ anonymous: true }));
    assert.equal(inboxOf(u).length, 0, "匿名帖通知了关注作者的人");
  });

  it("版块那一路还发，但**不带作者名也不带 actor**", () => {
    const u = follower("u_fan");
    follows(u, "board", BOARD);
    fanOut(post({ anonymous: true }));

    const inbox = inboxOf(u);
    assert.equal(inbox.length, 1);
    assert.doesNotMatch(inbox[0].title, /张三/);
    assert.equal(inbox[0].actorName, null, "actorName 会渲染成通知里的名字");
    assert.equal(inbox[0].actorId, null, "actorId 会渲染成头像，点进去就是本人");
  });
});

describe("**同一来源的多条会合并**", () => {
  it("一个版块连发三帖只留一条未读，count 累加", () => {
    const u = follower("u_fan");
    follows(u, "board", BOARD);

    fanOut(post({ id: "p1" }));
    fanOut(post({ id: "p2" }));
    fanOut(post({ id: "p3" }));

    const inbox = inboxOf(u);
    assert.equal(inbox.length, 1, "没合并，一天十帖就是十条通知");
    assert.equal(inbox[0].count, 3);
    assert.equal(inbox[0].title, "综合讨论有 3 个新帖");
  });

  it("**关注作者时合并说的是「发了 N 个」，不是「等 N 人」**", () => {
    /*
     * groupKey 按作者分，合并的永远是同一个人 ——
     * 「张三等 3 人」在说有三个人发了帖，而实际上只有张三一个。
     */
    const u = follower("u_fan");
    follows(u, "user", AUTHOR);

    fanOut(post());
    fanOut(post());

    const inbox = inboxOf(u);
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].title, "张三发了 2 个新帖");
  });
});
