/**
 * 本地看界面用的**合成**数据。不碰任何真实群数据。
 *
 *   npm run seed-ui
 *
 * 它刻意往极端处填：三十字的昵称、纯 emoji 的名字、六位数积分、
 * 六十层的楼、空的版块、没有任何回复的帖子 —— 界面的毛病都藏在这些地方，
 * 用「刚好合适」的假数据看界面等于什么都没看。
 *
 * 幂等：先按前缀清掉自己上次灌的，再重灌。
 */
import { createHash, randomBytes } from "node:crypto";

import { like, sql } from "drizzle-orm";

import { db, sqlite } from "@/lib/db";
import { segmentForIndex } from "@/lib/db/fts";
import {
  boards,
  checkins,
  dailyStats,
  groupMembers,
  groups,
  messages as messages_,
  notifications,
  people,
  pointsLedger,
  pollOptions,
  polls,
  posts,
  reactions,
  replies,
  roles,
  sessions,
  titles,
  userRoles,
  userTitles,
  users,
} from "@/lib/db/schema";
import { renderMarkdown } from "@/lib/markdown";

/** 所有合成行都带这个前缀，重跑时按它清场 */
const P = "seeduip_";
const DAY = 86_400_000;
const T0 = Date.parse("2026-08-13T12:00:00+08:00");

function at(daysAgo: number, hour = 10, minute = 0): number {
  return T0 - daysAgo * DAY - (12 - hour) * 3_600_000 - minute * 60_000;
}

function dateKey(ts: number): string {
  return new Date(ts + 8 * 3_600_000).toISOString().slice(0, 10);
}

// ── 清场 ────────────────────────────────────────────────────
function wipe() {
  const tables = [
    "forum_reactions",
    "forum_poll_options",
    "forum_polls",
    "forum_replies",
    "forum_posts",
    "notifications",
    "points_ledger",
    "checkins",
    "user_titles",
    "user_roles",
    "sessions",
    "daily_stats",
    "group_members",
    "messages",
    "people",
    "users",
    "groups",
  ];
  for (const t of tables) {
    const cols = sqlite.prepare(`PRAGMA table_info("${t}")`).all() as { name: string }[];
    const names = new Set(cols.map((c) => c.name));
    // 每张表挑一列能认出「这是种子灌的」
    const col = ["id", "user_id", "wx_id", "conv_id", "post_id"].find((c) => names.has(c));
    if (!col) continue;
    sqlite.prepare(`DELETE FROM "${t}" WHERE "${col}" LIKE '${P}%'`).run();
  }
  sqlite.prepare(`DELETE FROM messages_fts WHERE msg_id LIKE '${P}%'`).run();
  db.delete(titles).where(like(titles.key, `${P}%`)).run();
}

// ── 人 ──────────────────────────────────────────────────────
/** 名字刻意各走极端 —— 界面在这些地方最容易崩 */
const PEOPLE = [
  { wx: "you", name: "沈书言", user: true, admin: true },
  { wx: "a", name: "林可", user: true },
  { wx: "b", name: "周叙白", user: true },
  { wx: "c", name: "Nathaniel Featherstonehaugh", user: true },
  { wx: "d", name: "阿七", user: true },
  { wx: "e", name: "一个把自己的群昵称写得非常非常长的人你看它会不会撑破卡片", user: true },
  { wx: "f", name: "🦑🛰️🫧", user: true },
  { wx: "g", name: "陈迟", user: true },
  { wx: "h", name: "kk", user: true },
  { wx: "i", name: "苏晚意", user: true },
  { wx: "j", name: "老张", user: false },
  { wx: "k", name: "Ｍｉｄｏｒｉ", user: false },
  { wx: "l", name: "程屿", user: false },
  { wx: "m", name: "夜航船", user: false },
];

const GROUPS = [
  { id: `${P}conv_main`, name: "Agentic Lab 主群", members: PEOPLE.map((p) => p.wx) },
  {
    id: `${P}conv_long`,
    name: "把群名起得很长的那个群 · 二零二六年秋季 · 仅限内部讨论使用",
    members: ["you", "a", "b", "c", "f", "j"],
  },
  { id: `${P}conv_small`, name: "三人小群", members: ["you", "d", "i"] },
];

const SENTENCES = [
  "这个我昨天试过了，结论是能跑但慢，瓶颈在 tokenizer 那一层。",
  "有人看过那篇讲 speculative decoding 的吗，链接我贴一下 https://example.com/paper",
  "[旺柴]",
  "同意，不过我更担心的是可维护性 —— 三个月后没人看得懂这段。",
  "我这边复现不了，你的 node 版本是多少？",
  "刚提了个 PR，顺手把那个 off-by-one 修了。",
  "好耶",
  "有点长但值得读完：我们其实在两个层面上讨论同一件事。第一层是接口应该长什么样，这一层大家分歧不大；第二层是谁来负责在出错时兜底，这一层才是真正的分歧所在。我倾向于让调用方兜，因为它知道自己的上下文，而库不知道。",
  "[捂脸]这个坑我踩过",
  "晚上有空的话我们开个会对一下？",
  "数据我放共享盘了，路径是 /data/2026-08/",
  "别用那个库，作者半年没维护了。",
  "?",
  "补充一下背景：这个需求最早是从客服那边提上来的。",
  "我先睡了，明天继续[月亮]",
];

async function main() {
  console.log("→ 清掉上一次的合成数据");
  wipe();

  const nowTs = Date.now();

  // ── 群 ────────────────────────────────────────────────────
  console.log("→ 群与人");
  for (const g of GROUPS) {
    db.insert(groups)
      .values({
        convId: g.id,
        name: g.name,
        isGroup: true,
        bound: true,
        syncEnabled: true,
        countForPoints: true,
        publicLeaderboard: g.id.endsWith("main"),
        description: g.id.endsWith("small") ? null : "合成数据，用来看界面。",
        memberCount: g.members.length,
        messageCount: 0,
        lastMessageAt: at(0, 11),
      })
      .run();
  }

  // ── people / users ────────────────────────────────────────
  const userIdByWx = new Map<string, string>();
  for (const [i, p] of PEOPLE.entries()) {
    const wxId = `${P}wx_${p.wx}`;
    db.insert(people)
      .values({
        wxId,
        displayName: p.name,
        messages: 0,
        qualityMessages: 0,
        groupCount: GROUPS.filter((g) => g.members.includes(p.wx)).length,
        firstSeen: at(120),
        lastSeen: at(i % 9),
      })
      .run();

    if (!p.user) continue;

    const id = `${P}u_${p.wx}`;
    userIdByWx.set(p.wx, id);
    // 积分/等级/连签刻意拉开量级：六位数和 0 在同一张榜上是最能照出排版问题的
    const points = [128_640, 9_820, 4_310, 2_005, 860, 431, 208, 96, 12, 0][i % 10];
    db.insert(users)
      .values({
        id,
        wxId,
        wxNickname: p.name,
        siteNickname: p.wx === "e" ? null : undefined,
        bio:
          p.wx === "you"
            ? "在做一个把微信群存档下来的站。"
            : p.wx === "c"
              ? "Long bio to see how the profile card wraps when someone writes several sentences about themselves without any line breaks at all."
              : p.wx === "d"
                ? null
                : "随便写点什么。",
        username: `${p.wx}${p.wx}`,
        kind: "member",
        status: p.wx === "h" ? "suspended" : "active",
        level: Math.max(1, 10 - i),
        points,
        pointsTotal: points + 500,
        streakCurrent: [143, 21, 7, 3, 1, 0][i % 6],
        streakBest: [143, 60, 30, 12, 5, 1][i % 6],
        lastCheckinDate: dateKey(at(i % 3)),
        firstBoundAt: at(90),
        lastActiveAt: at(i % 9),
      })
      .run();
  }

  const me = userIdByWx.get("you")!;

  // ── 群成员 ────────────────────────────────────────────────
  for (const g of GROUPS) {
    for (const wx of g.members) {
      const p = PEOPLE.find((x) => x.wx === wx)!;
      db.insert(groupMembers)
        .values({
          convId: g.id,
          wxId: `${P}wx_${wx}`,
          wxName: p.name,
          displayName: wx === "a" && g.id.endsWith("main") ? "小林（产品）" : null,
          messages: 0,
          joinedAt: at(200),
          isAdmin: wx === "you",
        })
        .run();
    }
  }

  // ── 消息 ──────────────────────────────────────────────────
  console.log("→ 消息与日统计");
  const insertFts = sqlite.prepare(
    `INSERT INTO messages_fts (msg_id, conv_id, sender_wx_id, content) VALUES (?, ?, ?, ?)`,
  );
  const buckets = new Map<string, { messages: number; quality: number; chars: number; hours: number[]; first: number; last: number }>();
  const perPerson = new Map<string, { messages: number; quality: number }>();

  let n = 0;
  const seedMessages = sqlite.transaction(() => {
    for (let d = 44; d >= 0; d--) {
      for (const g of GROUPS) {
        // 小群冷清、长名群中等、主群热闹 —— 密度差本身就是要看的东西
        const perDay = g.id.endsWith("main") ? 14 : g.id.endsWith("long") ? 5 : 1;
        for (let k = 0; k < perDay; k++) {
          const wx = g.members[(d * 7 + k * 3) % g.members.length];
          // 作息：多数在 9~23 点，少数深夜
          const hour = [9, 10, 11, 13, 14, 15, 16, 20, 21, 22, 23, 2][(d + k) % 12];
          const ts = at(d, hour, (k * 13) % 60);
          const content = SENTENCES[(d * 5 + k) % SENTENCES.length];
          const id = `${P}m_${n++}`;
          const isQuality = content.length >= 15;

          db.insert(messages_)
            .values({
              id,
              convId: g.id,
              senderWxId: `${P}wx_${wx}`,
              senderName: PEOPLE.find((x) => x.wx === wx)!.name,
              isSend: false,
              type: "text",
              content,
              length: content.length,
              isQuality,
              hasMedia: false,
              ts,
              tier: "hot",
              indexed: true,
            })
            .run();
          insertFts.run(id, g.id, `${P}wx_${wx}`, segmentForIndex(content));

          const key = `${P}wx_${wx} ${g.id} ${dateKey(ts)}`;
          let b = buckets.get(key);
          if (!b) {
            b = { messages: 0, quality: 0, chars: 0, hours: Array(24).fill(0), first: ts, last: ts };
            buckets.set(key, b);
          }
          b.messages++;
          if (isQuality) b.quality++;
          b.chars += content.length;
          b.hours[new Date(ts + 8 * 3_600_000).getUTCHours()]++;
          b.first = Math.min(b.first, ts);
          b.last = Math.max(b.last, ts);

          const pp = perPerson.get(wx) ?? { messages: 0, quality: 0 };
          pp.messages++;
          if (isQuality) pp.quality++;
          perPerson.set(wx, pp);
        }
      }
    }

    for (const [key, b] of buckets) {
      const [wxId, convId, date] = key.split(" ");
      db.insert(dailyStats)
        .values({
          wxId,
          convId,
          date,
          messages: b.messages,
          qualityMessages: b.quality,
          charsTotal: b.chars,
          firstMsgAt: b.first,
          lastMsgAt: b.last,
          hourHistogram: b.hours,
        })
        .run();
    }
  });
  seedMessages();

  for (const [wx, pp] of perPerson) {
    db.update(people)
      .set({ messages: pp.messages, qualityMessages: pp.quality })
      .where(sql`wx_id = ${`${P}wx_${wx}`}`)
      .run();
  }
  for (const g of GROUPS) {
    const cnt = sqlite
      .prepare(`SELECT count(*) n FROM messages WHERE conv_id = ?`)
      .get(g.id) as { n: number };
    db.update(groups).set({ messageCount: cnt.n }).where(sql`conv_id = ${g.id}`).run();
  }
  console.log(`  ${n} 条消息`);

  // ── 角色 ──────────────────────────────────────────────────
  const ownerRole = db.select().from(roles).where(sql`key = 'owner'`).get();
  const memberRole = db.select().from(roles).where(sql`key = 'member'`).get();
  if (ownerRole) {
    db.insert(userRoles)
      .values({ id: `${P}ur_owner`, userId: me, roleId: ownerRole.id, grantReason: "合成数据" })
      .run();
  }
  if (memberRole) {
    for (const [wx, uid] of userIdByWx) {
      if (wx === "you") continue;
      db.insert(userRoles)
        .values({ id: `${P}ur_${wx}`, userId: uid, roleId: memberRole.id, grantReason: "合成数据" })
        .run();
    }
  }

  // ── 称号 ──────────────────────────────────────────────────
  console.log("→ 称号、积分、签到");
  const TITLES = [
    { key: `${P}t_early`, name: "元老", icon: "🌱", rarity: "rare", color: "#0d5c47" },
    { key: `${P}t_night`, name: "夜航员", icon: "🌙", rarity: "epic", color: "#4f6bd1" },
    { key: `${P}t_help`, name: "有问必答", icon: "🛟", rarity: "common", color: "#a9741a" },
    { key: `${P}t_long`, name: "一个名字特别长的称号看看徽章会不会被撑破", icon: "📏", rarity: "legendary", color: "#bf3b2c" },
  ];
  const titleIds: string[] = [];
  for (const [i, t] of TITLES.entries()) {
    const id = `${P}ti_${i}`;
    titleIds.push(id);
    db.insert(titles)
      .values({
        id,
        key: t.key,
        name: t.name,
        description: "合成数据。",
        icon: t.icon,
        color: t.color,
        rarity: t.rarity as never,
        source: "grant",
        sort: i,
      })
      .run();
  }
  for (const [i, [wx, uid]] of [...userIdByWx].entries()) {
    const tid = titleIds[i % titleIds.length];
    db.insert(userTitles)
      .values({ id: `${P}ut_${wx}`, userId: uid, titleId: tid, source: "grant", grantReason: "合成数据" })
      .run();
    db.update(users).set({ activeTitleId: tid }).where(sql`id = ${uid}`).run();
  }

  // ── 积分流水 + 签到 ───────────────────────────────────────
  let bal = 0;
  for (let d = 20; d >= 0; d--) {
    const delta = [12, 8, 20, 5, 15][d % 5];
    bal += delta;
    db.insert(pointsLedger)
      .values({
        id: `${P}pl_${d}`,
        userId: me,
        delta,
        balanceAfter: bal,
        ruleKey: "checkin",
        reason: "每日签到",
        createdAt: at(d, 9),
      })
      .run();
    db.insert(checkins)
      .values({
        id: `${P}ck_${d}`,
        userId: me,
        date: dateKey(at(d)),
        pointsAwarded: delta,
        basePoints: 5,
        qualityBonus: delta - 5,
        streakAfter: 21 - d,
        createdAt: at(d, 9),
      })
      .run();
  }
  // 一笔管理员扣分：负数在流水里长什么样也要看
  db.insert(pointsLedger)
    .values({
      id: `${P}pl_neg`,
      userId: me,
      delta: -50,
      balanceAfter: bal - 50,
      reason: "测试用的扣分，看看负数怎么显示",
      operatorId: me,
      createdAt: at(2, 15),
    })
    .run();

  // ── 论坛 ──────────────────────────────────────────────────
  console.log("→ 论坛");
  const boardRows = db.select().from(boards).all();
  if (boardRows.length === 0) throw new Error("没有版块 —— 先跑 npm run bootstrap");

  const md = async (s: string) => (await renderMarkdown(s)).html;

  const LONG_BODY = `# 我们到底在争什么

先把结论放前面：**两派其实没有分歧**，只是站在不同的抽象层上说话。

## 一、现象

线上这半年一共出过 7 次同类事故，我把它们按根因分了两类：

| 类型 | 次数 | 平均恢复 |
|---|---|---|
| 上游超时未兜底 | 4 | 23 分钟 |
| 缓存与库不一致 | 3 | 1 小时 41 分 |

第二类每一次都更久 —— 因为它**不报错**，只是慢慢地不对。

## 二、代码

\`\`\`ts
// 问题出在这里：先写缓存再写库，中间任何一次崩溃都留下一个说谎的缓存
await cache.set(key, next);
await db.update(row).set(next);
\`\`\`

顺序反过来就完了？没有。反过来之后失败窗口从「缓存说谎」变成「缓存过期」，
后者是可自愈的，前者不是。这就是全部的差别，但它值一小时四十一分钟。

## 三、公式

设失效概率为 $p$，则 $n$ 次读取中至少一次读到脏数据的概率是

$$P = 1 - (1-p)^n$$

> 引用一句评审里的话：「能自愈的错误不算错误，不能自愈的小错误才是事故。」

- 第一条
- 第二条
  - 嵌套的一条
- 第三条

最后贴个图看看排版：

![示意图](https://example.com/not-a-real-image.png)
`;

  type PostSpec = {
    key: string;
    board: number;
    author: string;
    title: string;
    body: string;
    daysAgo: number;
    type?: string;
    pinned?: boolean;
    featured?: boolean;
    anonymous?: boolean;
    bounty?: number;
    replies?: number;
    status?: string;
    poll?: string[];
  };

  const SPECS: PostSpec[] = [
    { key: "pin", board: 0, author: "you", title: "站点公告：这一版改了什么", body: "这周把口头禅重做了一遍，从「说得最多」改成「说得怪」。\n\n还有几处小修，见下。", daysAgo: 1, pinned: true, featured: true, replies: 4 },
    { key: "long", board: 0, author: "b", title: "关于缓存一致性的一次复盘（长文，含代码与公式）", body: LONG_BODY, daysAgo: 3, replies: 12 },
    {
      key: "longtitle",
      board: 1,
      author: "e",
      title: "一个标题特别特别长的帖子用来看看列表里的标题会不会换行会不会被截断会不会把右边的元信息挤走",
      body: "正文很短。",
      daysAgo: 4,
      replies: 1,
    },
    { key: "q", board: 1, author: "d", title: "SQLite 的 WAL 在多进程下到底安不安全？", body: "看了半天文档还是没搞清楚。有人实测过吗？", daysAgo: 5, type: "question", bounty: 200, replies: 6 },
    { key: "anon", board: 2, author: "i", title: "匿名问一句：我们是不是把这个项目做复杂了", body: "不是抱怨，是真心想问。", daysAgo: 6, anonymous: true, replies: 8 },
    { key: "poll", board: 2, author: "a", title: "下次线下活动定在哪个周末？", body: "投个票。", daysAgo: 2, type: "poll", poll: ["8 月 23 日", "8 月 30 日", "9 月 6 日", "都不行"], replies: 3 },
    { key: "hot", board: 0, author: "c", title: "六十层的帖子长什么样", body: "纯粹是为了把回复列表撑满。", daysAgo: 8, replies: 60 },
    { key: "empty", board: 3, author: "g", title: "一条回复都没有的帖子", body: "冷清也是一种状态，它也得好看。", daysAgo: 9 },
    { key: "short", board: 3, author: "f", title: "?", body: "?", daysAgo: 10, replies: 2 },
    { key: "locked", board: 1, author: "b", title: "这个帖子被锁了", body: "已经解决了，锁一下。", daysAgo: 12, status: "locked", replies: 5 },
    { key: "show", board: 4 % boardRows.length, author: "a", title: "做了个小工具，把群里的链接自动整理成目录", body: "周末两天写的，代码在 github 上。\n\n- 支持 GitHub / 掘金 / arXiv\n- 自动去重\n- 有个很丑的前端", daysAgo: 14, type: "showcase", replies: 7 },
  ];

  let postIdx = 0;
  for (const s of SPECS) {
    const board = boardRows[s.board % boardRows.length];
    const pid = `${P}p_${s.key}`;
    const created = at(s.daysAgo, 14);
    const replyCount = s.replies ?? 0;
    const html = await md(s.body);

    db.insert(posts)
      .values({
        id: pid,
        boardId: board.id,
        authorId: userIdByWx.get(s.author)!,
        title: s.title,
        content: s.body,
        contentHtml: html,
        excerpt: s.body.replace(/[#*`>|\-\n]/g, " ").slice(0, 120).trim(),
        type: (s.type ?? "discussion") as never,
        status: (s.status ?? "published") as never,
        visibility: "member",
        pinned: Boolean(s.pinned),
        featured: Boolean(s.featured),
        featuredBy: s.featured ? me : null,
        featuredAt: s.featured ? created : null,
        anonymous: Boolean(s.anonymous),
        bountyPoints: s.bounty ?? 0,
        viewCount: 30 + postIdx * 47,
        replyCount,
        reactionCount: postIdx % 5,
        lastReplyAt: replyCount ? created + 3_600_000 * replyCount : null,
        createdAt: created,
        updatedAt: created,
        lockedBy: s.status === "locked" ? me : null,
        lockReason: s.status === "locked" ? "已经解决了" : null,
      })
      .run();

    // 回复
    const bodies = [
      "同意。",
      "我补一个反例：在只有一个写进程的场景下这条不成立。",
      "有 benchmark 吗？",
      "刚试了，确实是这样。\n\n```sh\n$ npm run bench\nok 1240ms\n```",
      "这段我看不懂，能展开讲讲吗",
      "[强]",
      "顶一下，这个问题我也遇到过，而且当时排查了整整一个下午最后发现是环境变量拼错了一个字母，说出来都觉得离谱。",
    ];
    for (let f = 1; f <= replyCount; f++) {
      const wx = PEOPLE[(postIdx + f) % PEOPLE.length].wx;
      const uid = userIdByWx.get(wx) ?? me;
      const content = bodies[(postIdx + f) % bodies.length];
      db.insert(replies)
        .values({
          id: `${P}r_${s.key}_${f}`,
          postId: pid,
          parentId: f > 3 && f % 4 === 0 ? `${P}r_${s.key}_${f - 1}` : null,
          authorId: uid,
          content,
          contentHtml: await md(content),
          floor: f,
          accepted: s.key === "q" && f === 2,
          anonymous: s.anonymous === true && f % 3 === 0,
          reactionCount: f % 3,
          createdAt: created + f * 3_600_000,
          updatedAt: created + f * 3_600_000,
        })
        .run();
    }
    if (s.key === "q") {
      db.update(posts).set({ solvedReplyId: `${P}r_q_2` }).where(sql`id = ${pid}`).run();
    }

    // 投票
    if (s.poll) {
      const pollId = `${P}poll_${s.key}`;
      db.insert(polls)
        .values({ id: pollId, postId: pid, question: "你哪个周末有空？", multi: false, createdAt: created })
        .run();
      for (const [oi, text] of s.poll.entries()) {
        db.insert(pollOptions)
          .values({ id: `${P}po_${s.key}_${oi}`, pollId, text, sort: oi, votes: [7, 3, 11, 1][oi] ?? 0 })
          .run();
      }
    }

    // 反应
    for (let ri = 0; ri < postIdx % 5; ri++) {
      const wx = PEOPLE[ri % PEOPLE.length].wx;
      const uid = userIdByWx.get(wx);
      if (!uid) continue;
      db.insert(reactions)
        .values({
          id: `${P}rx_${s.key}_${ri}`,
          targetType: "post",
          targetId: pid,
          userId: uid,
          kind: (["useful", "insight", "precise", "love"] as const)[ri % 4],
          createdAt: created + 60_000 * ri,
        })
        .run();
    }

    postIdx++;
  }

  // 版块计数
  for (const b of boardRows) {
    const row = sqlite
      .prepare(`SELECT count(*) n, max(created_at) last FROM forum_posts WHERE board_id = ? AND status != 'deleted'`)
      .get(b.id) as { n: number; last: number | null };
    db.update(boards).set({ postCount: row.n, lastPostAt: row.last }).where(sql`id = ${b.id}`).run();
  }

  // ── 通知 ──────────────────────────────────────────────────
  console.log("→ 通知");
  const NOTIFS = [
    { type: "reply_to_post", title: "周叙白 等 3 人回复了你的帖子", body: "同意。", count: 3, link: `/forum/p/${P}p_pin`, read: false },
    { type: "mention", title: "林可 在帖子里提到了你", body: "@沈书言 这个你怎么看", count: 1, link: `/forum/p/${P}p_long`, read: false },
    { type: "reaction", title: "5 个人觉得你的回复有用", count: 5, link: `/forum/p/${P}p_hot`, read: false },
    { type: "featured", title: "你的帖子被设为精华", body: "站点公告：这一版改了什么", count: 1, link: `/forum/p/${P}p_pin`, read: false },
    { type: "title", title: "解锁称号「夜航员」", count: 1, link: "/shop", read: false },
    { type: "system", title: "你在群里的一段发言被整理成了帖子", body: "需要你确认是否公开", count: 1, link: "/me", read: true },
    { type: "keyword", title: "关键词「向量检索」命中 2 条消息", count: 2, link: "/radar", read: true },
    { type: "moderation", title: "你的一条回复被折叠", body: "原因：偏离主题", count: 1, link: `/forum/p/${P}p_anon`, read: true },
  ];
  for (const [i, x] of NOTIFS.entries()) {
    db.insert(notifications)
      .values({
        id: `${P}n_${i}`,
        userId: me,
        type: x.type as never,
        groupKey: `${x.type}:${i}`,
        count: x.count,
        title: x.title,
        body: x.body ?? null,
        link: x.link,
        readAt: x.read ? at(i) : null,
        createdAt: at(0, 12 - i),
        updatedAt: at(0, 12 - i),
      })
      .run();
  }

  // ── 会话 ──────────────────────────────────────────────────
  const token = randomBytes(32).toString("base64url");
  db.insert(sessions)
    .values({
      id: `${P}s_main`,
      userId: me,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      deviceName: "本地审计",
      ip: "127.0.0.1",
      userAgent: "seed-ui",
      expiresAt: nowTs + 30 * DAY,
    })
    .run();

  console.log("\n完成。用这个 cookie 登录：\n");
  console.log(`  al_session=${token}\n`);
  console.log(`  document.cookie = "al_session=${token}; path=/"`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
