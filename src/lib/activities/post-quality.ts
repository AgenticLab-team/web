/**
 * 「一篇够格的论坛帖子」是什么。纯函数，不碰数据库。
 *
 * ─────────────────────────────────────────
 * 为什么要有这条路
 * ─────────────────────────────────────────
 *
 * 域名活动原来只有一条门槛：群里 20 条高质量发言。
 * 那对**来得晚的人**是关死的 —— 20 条不是努力一下就能补上的，
 * 它需要时间，而活动不等人。
 *
 * 于是加一条并行的路：在论坛认真写一篇。
 * 两条是「或」的关系，谁先够谁算 —— 门槛的意义是筛掉不参与的人，
 * 不是筛掉来得晚的人。
 *
 * ─────────────────────────────────────────
 * 判定必须**偏向放行**
 * ─────────────────────────────────────────
 *
 * 误判的两个方向不对称：
 *
 * · 放过一篇灌水 → 多发一个域名，代价是几十块钱
 * · 拦下一篇真心写的 → 一个人认真写了几百字，被机器判成灌水，
 *   而且多半没有申诉的地方
 *
 * 第二种要糟糕得多。所以下面每一条都只拦**明显**的灌水，
 * 拿不准一律算过。真正的把关在人那一边：报名会进管理员的队列，
 * 那里能看到帖子原文。
 */

/** 门槛字数 —— 按「实打实的正文」算，不是原始长度 */
export const MIN_POST_CHARS = 100;

export interface PostQualityInput {
  title: string;
  content: string;
}

export interface PostQualityVerdict {
  ok: boolean;
  /** 算下来的实际正文字数 */
  chars: number;
  /** 没过的原因，给人看 */
  reason?: string;
}

/**
 * 把不算「写作」的东西去掉之后还剩多少字。
 *
 * ─────────────────────────────────────────
 * 为什么不直接用 content.length
 * ─────────────────────────────────────────
 *
 * 一百个换行、一串链接、一段粘贴来的代码，长度都能轻松过 100，
 * 而它们都不是这条门槛想要的东西。
 *
 * 但**代码块只是不计入字数，不构成扣分** —— 一篇「三百字讲解
 * 加一段代码」是这个社区最该鼓励的帖子。
 */
export function substantiveChars(input: PostQualityInput): number {
  const text = `${input.title}\n${input.content}`
    // 代码块：不算字数，也不算灌水
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    // 链接：地址本身不是写的字，链接文字留下
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    // Markdown 的记号
    .replace(/^[>#\-*+\s]+/gm, "")
    .replace(/[*_~|]/g, "")
    // 图片、HTML 标签
    .replace(/<[^>]+>/g, " ");

  // 空白一律不计：一百个换行不该顶一百个字
  return text.replace(/\s+/g, "").length;
}

/**
 * 一眼就能看出是灌水的那几种。
 *
 * 每一条都对应一种**真的会有人干**的事，而不是理论上的可能。
 * 拿不准的一律返回 null（= 不是灌水）。
 */
function obviousSpam(input: PostQualityInput): string | null {
  const body = `${input.title}\n${input.content}`
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\s+/g, "");

  if (body.length === 0) return "正文是空的";

  /*
   * 一、几乎全是同一个字。
   *
   * 「啊啊啊啊…」「1111…」。阈值定得很松：**不同字符少于 8 个**
   * 才算 —— 一篇一百多字的正常中文，不同字数轻松过几十。
   */
  const distinct = new Set(body).size;
  if (distinct < 8) return "整篇几乎只有几个字反复出现";

  /*
   * 二、同一段话复制粘贴凑长度。
   *
   * 按行去重之后，剩下的实打实内容不到三成就算 ——
   * 正常帖子里重复的行基本只有空行，而空行上面已经去掉了。
   */
  const lines = input.content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length >= 10);
  if (lines.length >= 4) {
    const unique = new Set(lines).size;
    if (unique / lines.length < 0.3) return "同一段内容重复了很多遍";
  }

  return null;
}

/**
 * 这篇帖子够不够格换一个域名。
 *
 * **不判断内容好不好** —— 那不是机器该做的判断，做了也会做错。
 * 这里只回答两件事：够不够长、是不是明显在凑数。
 */
export function judgePost(input: PostQualityInput): PostQualityVerdict {
  const chars = substantiveChars(input);

  /*
   * **先判长度，再判灌水**，顺序不能反。
   *
   * 反过来的话，一句「支持一下」会被回以「整篇几乎只有几个字反复出现」——
   * 一个只是写短了的人被指着说在灌水，而且他还不知道该改什么。
   *
   * 而且那几条灌水判据本来就只在长文上才成立：
   * 一篇 100 字里只有 3 个不同的字是灌水，四个字里有 3 个不同的字是正常。
   */
  if (chars < MIN_POST_CHARS) {
    return {
      ok: false,
      chars,
      reason: `实打实的正文还差 ${MIN_POST_CHARS - chars} 个字（链接、代码块和空行不算）`,
    };
  }

  const spam = obviousSpam(input);
  if (spam) return { ok: false, chars, reason: spam };

  return { ok: true, chars };
}

/** 指标名 —— 与 eligibility 的 METRIC_LABELS 对齐 */
export const QUALITY_POST_METRIC = "forum_quality_posts";
