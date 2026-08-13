import { MAX_WECHAT_LENGTH } from "@/lib/broadcast/rules";

import { LONGFORM_CHARS } from "@/lib/forum/longform";

import { MAX_PER_AUTHOR, selectDigest, type DigestCandidate, type Selection } from "./weekly";

/**
 * 每天晚上那一条。纯函数。
 *
 * ═════════════════════════════════════════
 * 它和周报**不是两套东西**
 * ═════════════════════════════════════════
 *
 * 选帖子那一整套判断（可见性白名单、往期发过的不再发、
 * 一个人最多占几条、够不够格）全部复用 `selectDigest`。
 *
 * 另写一份的话，两边迟早在「什么算可以发进群」上分叉 ——
 * 而分叉的方向永远是新写的那份更松（写的人当时想的是「先跑通」）。
 * 那一条判断管的是**别人的内容会不会被念给不该听的人**，
 * 是这个仓库里最不能有第二份实现的东西。
 *
 * ─────────────────────────────────────────
 * 「已经推过哪几篇」也只有一份
 * ─────────────────────────────────────────
 *
 * 日报和周报共用 `digest_runs` 那张表。分两张的话，
 * 周一早上刚推过的文章，周一晚上会被日报再推一次 ——
 * 而那正是让人开始忽略这个消息的第一步。
 *
 * ═════════════════════════════════════════
 * 日报和周报要说的**不是同一件事**
 * ═════════════════════════════════════════
 *
 * 这决定了两边的参数为什么不一样：
 *
 *   周报  「这一周最值得读的五篇」—— 回顾，所以看一整周、要求有互动
 *   日报  「今天有人写了这个」   —— 提醒，所以看最近几天、宁缺毋滥
 *
 * 日报最多三条：每天一条消息进群，五条会变成刷屏。
 * 而且它每天都出现，所以**门槛要比周报高** —— 周报一周一次，
 * 稍微凑一凑也还好；日报凑出来的那条，明天还会再来一次。
 */

/** 一天最多推几条。三条是「扫一眼就读完」和「够得上一条消息」的分寸 */
export const DAILY_MAX_ITEMS = 3;

/**
 * 往回看几天。
 *
 * 不是一天。只看当天的话，周末两天没人发帖就会连着两晚没有日报 ——
 * 而「有时候有、有时候没有」比「每天都有」更让人记不住这件事。
 * 三天的窗口让一篇好文有机会在它发出的那晚没被选中时，第二晚补上。
 *
 * 配合「发过的不再发」，同一篇不会因为窗口重叠被推两次。
 */
export const DAILY_LOOKBACK_DAYS = 3;

/**
 * 日报的互动门槛。
 *
 * 比周报高（周报是 2）。理由见上面：日报每天都来，
 * 凑数的代价是复利的 —— 连着三天推平庸内容，第四天就没人看了。
 *
 * 精华帖照旧免检（`selectDigest` 里那条），因为那是人工挑过的。
 */
export const DAILY_MIN_ENGAGEMENT = 3;

export function selectDaily(
  candidates: DigestCandidate[],
  alreadySent: ReadonlySet<string>,
): Selection {
  return selectDigest(candidates, {
    alreadySent,
    minEngagement: DAILY_MIN_ENGAGEMENT,
    /*
     * 够长就免检互动。
     *
     * 站长要的是「同步高质量文章」，而线上长文平均只有 0.21 条回复 ——
     * 只看互动的话，这个功能会**结构性地推不出任何一篇长文**，
     * 推出来的全是热闹的短帖。和「坐下来读」那一栏同一个门槛。
     */
    longformChars: LONGFORM_CHARS,
    max: DAILY_MAX_ITEMS,
    maxPerAuthor: MAX_PER_AUTHOR,
  });
}

export interface DailyRenderOptions {
  siteUrl: string;
  /** 「8 月 13 日」这种 */
  dateLabel: string;
  maxLength?: number;
}

/**
 * 渲染成发进群的那条文本。
 *
 * ─────────────────────────────────────────
 * 「提醒回到群里」那半句放在**最后**
 * ─────────────────────────────────────────
 *
 * 站长要的是「同步高质量文章 + 提醒回到群里」。
 * 把提醒放前面的话，这条消息第一眼就是在要东西 ——
 * 而一条开口就要东西的自动消息，第三天就没人往下看了。
 *
 * 先给内容，最后一行才是入口。人读完标题觉得有意思，
 * 那一行才有意义；觉得没意思，那一行也不会让他改主意。
 */
export function renderDaily(
  items: Selection["items"],
  options: DailyRenderOptions,
): string {
  const base = options.siteUrl.replace(/\/+$/, "");
  const lines = [`📖 ${options.dateLabel} · 今天值得读的`, ""];

  items.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.title}`);
    if (item.excerpt) lines.push(`   ${truncate(item.excerpt, 36)}`);
    lines.push(`   ${item.authorName} · ${item.reason}`);
    lines.push(`   ${base}/forum/p/${item.id}`);
    lines.push("");
  });

  // 最后一行才是入口 —— 先给东西，再给去处
  lines.push(`更多在 ${base}/forum/deep`);

  const text = lines.join("\n");
  const limit = options.maxLength ?? MAX_WECHAT_LENGTH;
  if (text.length <= limit) return text;

  // 超长就少放一条，而不是从中间截断 —— 截断会切出半个链接
  return items.length > 1 ? renderDaily(items.slice(0, items.length - 1), options) : text.slice(0, limit);
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/**
 * 今天这条到底发不发。
 *
 * **一条都没有就不发** —— 这条和周报那边是同一个判断，理由也一样：
 * 一条「今天值得读的：（空）」会教会所有人以后忽略这个消息。
 *
 * 但日报比周报更严格：周报要求至少两条（凑不满两条说明这周确实没什么），
 * 日报**一条就发**。因为日报的意义是「今天有人写了这个」，
 * 一篇好文就够了；而要求两条会让很多天变成没有，
 * 于是这件事重新变成「有时候有」。
 */
/**
 * 周一不发。
 *
 * ═════════════════════════════════════════
 * 因为周一已经有一条了
 * ═════════════════════════════════════════
 *
 * 每周精选是**周一 09:00** 备稿的（`agenticlab-digest.timer`）。
 * 那一条发出去之后，同一天晚上八点再来一条「今天值得读的」，
 * 群里一天收到两条来自同一个站的推送 —— 而这两条讲的还是
 * 高度重叠的内容（都从同一批帖子里挑，只是窗口不同）。
 *
 * 一天两条是「这个站开始刷屏了」的第一印象，而那个印象只需要
 * 建立一次。
 *
 * ─────────────────────────────────────────
 * 为什么不是「周报发了才跳过」
 * ─────────────────────────────────────────
 *
 * 那样更精确，但它把日报的行为绑在了另一个任务的结果上：
 * 周报因为没内容而没发的那些周一，日报会突然出现 ——
 * 于是「周一有没有推送」变成一件要查两处才能回答的事。
 *
 * 固定跳过周一，代价是偶尔少发一条，换来的是这件事**一句话说得清**。
 *
 * ⚠️ 用东八区的星期几。服务器时区不一定是东八，
 * 而「周一」对群里的人是他们的周一。
 */
export function isSkipDay(dateKey: string): boolean {
  // dateKey 已经是东八区切好的 YYYY-MM-DD，按 UTC 解析回来星期几才不会偏
  return new Date(`${dateKey}T00:00:00Z`).getUTCDay() === 1;
}

export function shouldSendDaily(
  selection: Selection,
  dateKey?: string,
): { send: boolean; reason: string } {
  if (dateKey && isSkipDay(dateKey)) {
    return { send: false, reason: "周一不发 —— 每周精选已经在这天早上占了一条" };
  }
  if (selection.items.length === 0) {
    return { send: false, reason: "今天没有够格的帖子 —— 宁可不发，也不发一条空的" };
  }
  return { send: true, reason: `${selection.items.length} 条` };
}
