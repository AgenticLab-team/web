import "server-only";

import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";

import { db, sqlite } from "@/lib/db";
import { groups, messages, personPhrases } from "@/lib/db/schema";
import { unsearchableWxIds } from "@/lib/privacy/queries";
import type { CurrentUser } from "@/lib/auth/session";
import { dateKey } from "@/lib/time";

import { MENTIONABLE_TYPES } from "@/lib/messages/interactions";
import { emojiOf, pickCatchphrases, tally, type Said } from "./catchphrase";

/**
 * 「常挂在嘴边」：算一轮存下来，读的时候白拿。
 *
 * ═════════════════════════════════════════
 * 名字叫「常挂在嘴边」而不是「口头禅」
 * ═════════════════════════════════════════
 *
 * 拿线上四万条消息跑出来的结果里，一半是真的口头禅
 * （「哈哈」「那个」「来了」），另一半是**他常聊的东西**
 * （「域名」「公益站」「妈妈」）。两者算法上分不开 ——
 * 都是「他说得比别人多得多的字」。
 *
 * 硬按「口头禅」发布的话，一半的人会看到一个明显不是口头禅的词，
 * 然后这块区域就不可信了。**改标题比改算法诚实**：
 * 「常挂在嘴边」对两种结果都成立。
 *
 * ═════════════════════════════════════════
 * 这是一个新的暴露出口
 * ═════════════════════════════════════════
 *
 * 同群的人翻聊天记录本来就看得到他说过什么 —— 但
 * **「他最爱说 X」是一句结论，而结论是翻记录翻不出来的**。
 * 聚合出来的画像比原始内容更进一步，这和关键词雷达当初漏接开关
 * 是同一件事（雷达是第五个出口，这是第六个）。
 *
 * 所以关掉「别人能搜到我的发言」的人，这一栏对别人不显示。
 * 他自己看自己照常看得到。
 */

/** 一个人至少要在这个群里说过这么多条，才进入计算 —— 和 catchphrase.ts 的门槛一致 */
const MIN_FOR_GROUP = 30;

export interface PhraseJobReport {
  groups: number;
  people: number;
  written: number;
  ms: number;
  /** 这一轮什么都没干（离上次算完还不够久） */
  skipped: boolean;
}

/**
 * 两轮之间至少隔这么久。
 *
 * 健康检查每 5 分钟跑一次，而这一步在线上实测要 **36 秒**
 * （11 个群、206 人够门槛）。不加节流的话就是每 5 分钟烧 36 秒 CPU，
 * 一直烧下去 —— 而它算的东西是一个人几个月的说话习惯，
 * 一天之内根本不会变。
 *
 * 挂在别的每 5 分钟的步骤后面很容易忽略这件事：单看那一步是对的，
 * 单看那个定时器也是对的，错的是两者的组合。
 */
export const RECOMPUTE_EVERY_MS = 6 * 3_600_000;

/**
 * 全站算一轮。**只有定时任务调它。**
 *
 * 逐群算：基准（同群其他人）对一个群只有一份，算一次给这个群里
 * 所有人用。每人各算一次基准的话是每人 1.9 秒 + 1.5 秒 ——
 * 实测十二个人要 5 分钟，而这样一整轮只要几秒。
 */
export function computePersonPhrases(options: { force?: boolean } = {}): PhraseJobReport {
  const started = Date.now();
  const report: PhraseJobReport = { groups: 0, people: 0, written: 0, ms: 0, skipped: false };

  if (!options.force) {
    /*
     * 上一轮什么时候算完的 —— 直接问最新的那一行，不另存一个时间戳。
     *
     * 另存一个的话就有两处真相：某次任务中途崩掉，时间戳写了、
     * 行没写完，下一轮会以为算过了。
     */
    const last = db
      .select({ at: personPhrases.computedAt })
      .from(personPhrases)
      .orderBy(desc(personPhrases.computedAt))
      .limit(1)
      .get();
    if (last && started - last.at < RECOMPUTE_EVERY_MS) {
      report.skipped = true;
      report.ms = Date.now() - started;
      return report;
    }
  }

  const convIds = db
    .select({ convId: groups.convId })
    .from(groups)
    .where(eq(groups.syncEnabled, true))
    .all()
    .map((g) => g.convId);

  /*
   * 名册：`sender_name`（说过话的人）**加上** `message_mentions.name`
   * （被 @ 过的字面昵称）。
   *
   * 只用前者不够 —— 群里天天被叫的那几个名字，本人可能一句话没说过
   * （机器人、潜水的人）。线上第一版就因此把「群猫娘」当成了
   * 某个人的口头禅。
   */
  const names = new Set<string>();
  for (const r of sqlite
    .prepare("SELECT DISTINCT sender_name AS n FROM messages WHERE sender_name IS NOT NULL")
    .all() as { n: string }[]) {
    names.add(r.n);
  }
  for (const r of sqlite
    .prepare("SELECT DISTINCT name AS n FROM message_mentions")
    .all() as { n: string }[]) {
    names.add(r.n);
  }
  const exclude = [...names];

  const types = [...MENTIONABLE_TYPES];

  for (const convId of convIds) {
    const rows = db
      .select({ wxId: messages.senderWxId, content: messages.content, ts: messages.ts })
      .from(messages)
      .where(
        and(
          eq(messages.convId, convId),
          inArray(messages.type, types),
          isNotNull(messages.senderWxId),
          isNotNull(messages.content),
        ),
      )
      .orderBy(messages.ts)
      .all();

    if (rows.length === 0) continue;
    report.groups++;

    const said = (r: (typeof rows)[number]): Said => ({
      text: r.content ?? "",
      day: dateKey(r.ts),
    });

    /*
     * 基准包含**所有人**，包括正在算的那个人自己。
     *
     * 把自己剔出去的话，一个人说的话占全群比重越大，他的基准就越低、
     * lift 越高 —— 于是最活跃的人天然拿到最夸张的倍数。
     * 那个倍数量的是「他有多活跃」，不是「这个词有多像他」。
     */
    const baseline = tally(rows.map(said));

    const byPerson = new Map<string, Said[]>();
    for (const r of rows) {
      if (!r.wxId) continue;
      const list = byPerson.get(r.wxId);
      if (list) list.push(said(r));
      else byPerson.set(r.wxId, [said(r)]);
    }

    for (const [wxId, mine] of byPerson) {
      if (mine.length < MIN_FOR_GROUP) continue;
      report.people++;

      // 最常用的表情。和口头禅分开算，因为它不是他说的话
      const emojiCount = new Map<string, number>();
      for (const m of mine) {
        for (const e of emojiOf(m.text)) {
          if (PLACEHOLDERS.has(e)) continue;
          emojiCount.set(e, (emojiCount.get(e) ?? 0) + 1);
        }
      }
      /*
       * 表情也给前几个 —— 一个表情和一个词一样，说不出一个人的样子。
       * 「🐟 / 🤔 / 😭」放在一起才有轮廓。
       */
      const emojiRanked = [...emojiCount.entries()]
        .filter(([, n]) => n >= MIN_EMOJI)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 5);
      const topEmoji = emojiRanked[0];

      const picked = pickCatchphrases({
        mine,
        others: baseline,
        otherMessages: rows.length,
        exclude,
      });
      const got = picked[0];

      if (!got && !topEmoji) {
        // 这一轮两样都没算出来 —— 把上一轮的删掉，别让过期的结论留在页面上
        db.delete(personPhrases)
          .where(and(eq(personPhrases.wxId, wxId), eq(personPhrases.convId, convId)))
          .run();
        continue;
      }

      /*
       * 只有表情、没有口头禅时也要写一行 —— 这时 phrase 存空串。
       * 读的那一头靠「空串 = 没有」判，和 `github_facts` 那边同一套写法。
       */
      const row = {
        phrase: got?.phrase ?? "",
        /*
         * 冠军留在列上、其余进 JSON —— 成员列表那一页只要冠军，
         * 让它去解 JSON 再取第一个是为不需要的通用性付常数代价。
         */
        morePhrases: picked.slice(1).map((c) => ({
          phrase: c.phrase,
          hits: c.hits,
          days: c.days,
          lift: c.lift,
        })),
        moreEmoji: emojiRanked.slice(1).map(([emoji, hits]) => ({ emoji, hits })),
        hits: got?.hits ?? 0,
        msgs: got?.msgs ?? 0,
        days: got?.days ?? 0,
        lift: got?.lift ?? 0,
        score: got?.score ?? 0,
        emoji: topEmoji?.[0] ?? null,
        emojiHits: topEmoji?.[1] ?? null,
        computedAt: Date.now(),
      };

      db.insert(personPhrases)
        .values({ wxId, convId, ...row })
        .onConflictDoUpdate({
          target: [personPhrases.wxId, personPhrases.convId],
          set: row,
        })
        .run();
      report.written++;
    }
  }

  report.ms = Date.now() - started;
  return report;
}

export interface CatchphraseView {
  phrase: string;
  hits: number;
  days: number;
  lift: number;
  /** 排在后面的那几个（最多四个）。冠军是上面那几个字段 */
  more: { phrase: string; hits: number; days: number; lift: number }[];
}

export interface EmojiView {
  emoji: string;
  hits: number;
  /** 排在后面的那几个 */
  more: { emoji: string; hits: number }[];
}

/**
 * 这个人「常挂在嘴边」的那个词 —— 只看**查看者看得见的那几个群**。
 *
 * `convIds` 由调用方按共同群算好（`personProfileFor` 那一套）。
 * 传全站的群进来等于把他在别的群的说话习惯透给你，
 * 而那些群的存在本身就不该让你知道。
 */
export function catchphraseFor(
  viewer: CurrentUser | null,
  wxId: string,
  convIds: string[],
): CatchphraseView | null {
  if (convIds.length === 0) return null;

  /*
   * 隐私开关：关掉「别人能搜到我的发言」的人，这一栏对别人不显示。
   *
   * 他自己看自己照常看得到 —— `unsearchableWxIds` 已经把
   * 「查看者自己」排除在外了（和检索那几个出口同一套判定，
   * 不在这里另写一份）。
   */
  if (unsearchableWxIds(viewer).includes(wxId)) return null;

  const row = db
    .select()
    .from(personPhrases)
    .where(and(eq(personPhrases.wxId, wxId), inArray(personPhrases.convId, convIds)))
    // 跨群取最像他的那个，而不是最近算的那个
    .orderBy(desc(personPhrases.score))
    .limit(1)
    .get();

  if (!row || !row.phrase) return null;
  return {
    phrase: row.phrase,
    hits: row.hits,
    days: row.days,
    lift: row.lift,
    /*
     * 后面那几个。站长：「常说的词怎么还有一个，3～5 个左右」。
     *
     * 一个词说不出一个人的样子 ——「卧槽」只说明他会惊讶；
     * 「卧槽 / 确实 / 笑死 / 没绷住」放在一起才是一种人。
     */
    more: row.morePhrases ?? [],
  };
}

/**
 * 他点得最多的微信表情。和口头禅走同一张表、同一套边界
 * （共同群 + 隐私开关），但**分开取** —— 一个人可能只有其中一样。
 */
export function topEmojiFor(
  viewer: CurrentUser | null,
  wxId: string,
  convIds: string[],
): EmojiView | null {
  if (convIds.length === 0) return null;
  if (unsearchableWxIds(viewer).includes(wxId)) return null;

  const row = db
    .select()
    .from(personPhrases)
    .where(and(eq(personPhrases.wxId, wxId), inArray(personPhrases.convId, convIds)))
    .orderBy(desc(personPhrases.emojiHits))
    .limit(1)
    .get();

  if (!row?.emoji || !row.emojiHits) return null;
  return { emoji: row.emoji, hits: row.emojiHits, more: row.moreEmoji ?? [] };
}


export interface MentionPartner {
  wxId: string;
  name: string;
  /** 双向合计：他 @ 对方 + 对方 @ 他 */
  count: number;
}

/**
 * 和谁 @ 得最多 —— **只在共同群里数**。
 *
 * ═════════════════════════════════════════
 * 为什么叫「@ 得最多」而不是「聊得最多」
 * ═════════════════════════════════════════
 *
 * 群消息的**回复关系卡在上游**：NekoBot 的接口不透传引用目标，
 * 所以「谁回了谁」这条边整个是空的（见 ROADMAP 第一节）。
 * 手上只有 @。
 *
 * 写成「聊得最多」的话，那是一句我们答不上来的话 ——
 * 两个人天天对着聊、一次没 @ 过，这里会说他们不熟。
 * **一个说得比实际多的标题，比没有这个功能更糟**：
 * 没有的话人不会误解，有了他会信。
 *
 * ═════════════════════════════════════════
 * 双向合计
 * ═════════════════════════════════════════
 *
 * 只数「他 @ 别人」的话，一个从不 @ 人、但被所有人 @ 的人
 * 会显示成「没有」；只数被 @ 同理。@ 本来就是一来一回的事。
 */
export function topMentionPartner(
  viewer: CurrentUser | null,
  wxId: string,
  convIds: string[],
): MentionPartner | null {
  if (convIds.length === 0) return null;
  if (unsearchableWxIds(viewer).includes(wxId)) return null;

  const holes = convIds.map(() => "?").join(",");
  /*
   * 对方也要过一遍隐私开关：一个关掉了「别人能搜到我的发言」的人，
   * 不该因为**别人**的主页而被点名。
   *
   * 这一条很容易漏 —— 想着「这是 A 的主页，管 A 的开关就行了」，
   * 而结论里其实有两个人。
   */
  const hidden = unsearchableWxIds(viewer);
  const hiddenHoles = hidden.length > 0 ? hidden.map(() => "?").join(",") : "''";

  const row = sqlite
    .prepare(
      `WITH pairs AS (
         -- 他 @ 别人
         SELECT mm.wx_id AS other
         FROM message_mentions mm
         JOIN messages m ON m.id = mm.message_id
         WHERE mm.conv_id IN (${holes})
           AND m.sender_wx_id = ?
           AND mm.status = 'resolved'
           AND mm.wx_id IS NOT NULL
           AND mm.wx_id <> ?
         UNION ALL
         -- 别人 @ 他
         SELECT m.sender_wx_id AS other
         FROM message_mentions mm
         JOIN messages m ON m.id = mm.message_id
         WHERE mm.conv_id IN (${holes})
           AND mm.wx_id = ?
           AND mm.status = 'resolved'
           AND m.sender_wx_id IS NOT NULL
           AND m.sender_wx_id <> ?
       )
       SELECT p.other AS wxId,
              COALESCE(pe.display_name, p.other) AS name,
              COUNT(*) AS count
       FROM pairs p
       LEFT JOIN people pe ON pe.wx_id = p.other
       WHERE p.other NOT IN (${hiddenHoles})
       GROUP BY p.other
       ORDER BY count DESC, wxId
       LIMIT 1`,
    )
    .get(...convIds, wxId, wxId, ...convIds, wxId, wxId, ...hidden) as
    | { wxId: string; name: string; count: number }
    | undefined;

  /*
   * 一两次 @ 不叫「最多」。
   *
   * 门槛低于这个数的话，绝大多数人会拿到一个只 @ 过两次的「最常互动」——
   * 那句话本身没错，但它给人的印象是「这两个人很熟」。
   */
  if (!row || row.count < MIN_MENTIONS_FOR_PARTNER) return null;
  return row;
}

/**
 * 系统占位，不是他挑的表情。
 *
 * 正文里 `[图片]`「[视频]」这些是**消息类型的占位符**（上游不给媒体地址，
 * 图片消息的正文就是「[图片]」三个字），不是谁点的表情。
 * 不排掉的话，发图多的人「最常用的表情」会是「图片」。
 */
const PLACEHOLDERS = new Set([
  "图片", "视频", "语音", "链接", "文件", "位置", "动画表情", "转账", "红包",
  "名片", "聊天记录", "小程序", "音乐", "分享", "表情", "撤回一条消息",
]);

/** 至少点过这么多次，才谈得上「最常用」 */
const MIN_EMOJI = 5;

/** 至少来回 @ 过这么多次，才谈得上「最常」 */
export const MIN_MENTIONS_FOR_PARTNER = 5;

/**
 * 一批人的「常挂在嘴边」—— 成员目录用。
 *
 * ═════════════════════════════════════════
 * 为什么是批量，而不是每行调一次 catchphraseFor
 * ═════════════════════════════════════════
 *
 * 目录一页最多列几百人。每行一次查询就是几百条 SQL，
 * 而且 `unsearchableWxIds` 每次都要重新算一遍隐私名单 ——
 * 那是这个项目的地方病（N+1），性能守卫也盯着。
 *
 * ═════════════════════════════════════════
 * 返回的是 wx_id → 词，**调用方不许把 wx_id 传下去**
 * ═════════════════════════════════════════
 *
 * 目录那一层专门不把 wx_id 放进给客户端的结构里：它会被序列化进
 * RSC 载荷、出现在网页源码里，而拿着 wx_id 就能在微信里直接加人。
 * 这个函数在服务端把词取出来就够了 —— 过去的是词，不是号。
 */
export function catchphrasesFor(
  viewer: CurrentUser | null,
  wxIds: readonly string[],
  convIds: readonly string[],
  /**
   * 已经算好的隐私名单。调用方同时还要别的名单时传进来，
   * 省掉一次重复的权限判定（那一次判定本身就要跑两条查询）。
   * 不传就自己算 —— 默认必须是安全的那一边。
   */
  hiddenWxIds?: ReadonlySet<string>,
): Map<string, string> {
  const out = new Map<string, string>();
  if (wxIds.length === 0 || convIds.length === 0) return out;

  const hidden = hiddenWxIds ?? new Set(unsearchableWxIds(viewer));
  const wanted = wxIds.filter((w) => !hidden.has(w));
  if (wanted.length === 0) return out;

  const rows = db
    .select({
      wxId: personPhrases.wxId,
      phrase: personPhrases.phrase,
      score: personPhrases.score,
    })
    .from(personPhrases)
    .where(
      and(inArray(personPhrases.wxId, wanted), inArray(personPhrases.convId, [...convIds])),
    )
    // 同一个人可能在几个群里各有一个 —— 排好序之后取先遇到的那个
    .orderBy(desc(personPhrases.score))
    .all();

  for (const row of rows) {
    if (!row.phrase) continue;
    if (!out.has(row.wxId)) out.set(row.wxId, row.phrase);
  }
  return out;
}
