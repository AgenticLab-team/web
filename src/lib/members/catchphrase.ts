/**
 * 口头禅：他说得**比别人多得多**的那个词。纯统计，不联网、不查库。
 *
 * ═════════════════════════════════════════
 * 难的不是数，是「比别人多」
 * ═════════════════════════════════════════
 *
 * 只按词频排的话，每个人的口头禅都是「我们」「这个」「就是」——
 * 那不是口头禅，那是中文。一句对谁都成立的结论等于没有结论，
 * 而且它会让整块区域看起来像是坏的。
 *
 * 所以要的是**差得最开**的那个：他的使用率 ÷ 同群其他人的使用率。
 * 「卧槽」全群都说、他说得多三倍 —— 那才是他的口头禅。
 *
 * ═════════════════════════════════════════
 * 没有分词器，就不分词
 * ═════════════════════════════════════════
 *
 * 这个项目里没有中文分词。硬要引一个的话，代价是一个几 MB 的词典
 * 和一堆切错的边界 —— 而**口头禅本来就常常不是词**：
 * 「无所谓啦」「确实确实」「我不到啊」，分词器只会把它们切碎。
 *
 * 所以直接数 2–5 个字的连续片段。片段之间互相包含是必然的
 * （「哈哈」在「哈哈哈」里），下面用一条包含规则收拾。
 *
 * ═════════════════════════════════════════
 * 三种会骗过统计的东西
 * ═════════════════════════════════════════
 *
 *   · **一条被复制粘贴很多次的长消息** —— 一段签名档能让里面每个片段
 *     都刷到几百次。所以同时数「出现在多少条**不同**消息里」，
 *     只在一条消息里反复出现的不算
 *   · **昵称** —— 群里天天喊的名字频率极高，但那是别人的名字，
 *     不是他的口头禅。调用方把名册传进来排除
 *   · **URL、代码、数字** —— 只取汉字连续段，这三样自然就被切掉了
 */

/**
 * 片段长度范围。
 *
 * 上限从 5 收到 4，是拿真实数据跑出来的：5 个字的候选清一色是
 * **从长句里切出来的残片** ——「长断章取义」「组合的词元」
 * 「佳佳世一萌」。它们在统计上完全合法（确实反复出现），
 * 读起来却像乱码，而一个读起来像乱码的结论会让人怀疑整块区域。
 *
 * 汉语里真正会挂在嘴边的成分基本都是 2–4 个字（「确实」「哈哈哈」
 * 「断章取义」）。收到 4 之后，上面那三个残片各自退回它们
 * 本来的样子。
 */
const MIN_LEN = 2;
const MAX_LEN = 4;

/** 至少说过这么多条消息，才谈得上有口头禅 */
export const MIN_MESSAGES = 30;
/** 片段至少出现这么多次 */
export const MIN_HITS = 5;
/** 且要出现在这么多条**不同**的消息里 —— 挡住复制粘贴 */
export const MIN_DISTINCT = 4;
/**
 * 还要横跨这么多**不同的天**。
 *
 * 挡的是「那几天在聊这个」：一场持续两天的讨论能让某个词的
 * lift 冲到几百倍，但那是话题，不是这个人的习惯。
 * 习惯的特征就是它不挑日子。
 */
export const MIN_DAYS = 3;
/** 使用率至少是同群其他人的这么多倍 */
export const MIN_LIFT = 2;

export interface PhraseStat {
  /** 总共出现多少次 */
  hits: number;
  /** 出现在多少条不同的消息里 */
  msgs: number;
  /** 横跨多少个不同的天 */
  days: number;
  /** 上一条计入的那天，只用来数 days —— 见 tally */
  lastDay: string;
}

export interface Catchphrase {
  phrase: string;
  hits: number;
  msgs: number;
  days: number;
  /** 他的使用率是别人的几倍 */
  lift: number;
  /** 排名用的分数，见 pickCatchphrase 里那段说明 */
  score: number;
}

/**
 * 微信表情在正文里是 `[旺柴]` 这样的方括号词。
 *
 * 不摘掉的话，「旺柴」「捂脸」「流泪」会变成一堆人的「口头禅」——
 * 线上第一版跑出来 112 个人里有四个是「旺柴」。那不是他说的话，
 * 是他点的表情：说「他常把旺柴挂在嘴边、说过 52 次」是错的。
 *
 * 它们另有去处（见 `emojiOf` —— 最常用的表情本身是一条好统计），
 * 这里只负责把它们从「说过的话」里摘干净。
 */
const BRACKET = /\[[^\[\]]{1,8}\]/g;

/** 消息里的表情词，`[旺柴]` → `旺柴` */
export function emojiOf(text: string): string[] {
  return (text.match(BRACKET) ?? []).map((s) => s.slice(1, -1));
}

/**
 * 一条消息 → 里面所有 2–4 字的汉字片段。
 *
 * 只认汉字连续段：URL、代码、数字都在这一步被切开，不必再单独排除。
 * 方括号表情先摘掉（见 BRACKET）。
 */
export function phrasesOf(text: string): string[] {
  const out: string[] = [];
  for (const run of text.replace(BRACKET, "，").match(/[一-鿿]+/g) ?? []) {
    const chars = [...run];
    for (let len = MIN_LEN; len <= MAX_LEN; len++) {
      for (let i = 0; i + len <= chars.length; i++) {
        out.push(chars.slice(i, i + len).join(""));
      }
    }
  }
  return out;
}

export interface Said {
  text: string;
  /** 哪一天说的（`YYYY-MM-DD` 之类，只要同一天相等即可） */
  day: string;
}

/**
 * 一批消息 → 每个片段出现多少次、出现在多少条消息里、横跨多少天。
 *
 * **消息要按时间排好再传进来。** 数「横跨多少天」时只记上一条的日子，
 * 而不是攒一个日期集合 —— 三万条消息能产出几十万个片段，
 * 每个片段挂一个 Set 的话内存会翻十几倍。
 * 排好序之后一个字符串就够了。
 */
export function tally(messages: readonly Said[]): Map<string, PhraseStat> {
  const total = new Map<string, PhraseStat>();
  for (const { text, day } of messages) {
    // 同一条消息里重复出现只算一条「不同消息」，但次数照数
    const here = new Map<string, number>();
    for (const p of phrasesOf(text)) here.set(p, (here.get(p) ?? 0) + 1);
    for (const [p, n] of here) {
      const cur = total.get(p);
      if (cur) {
        cur.hits += n;
        cur.msgs += 1;
        if (cur.lastDay !== day) {
          cur.days += 1;
          cur.lastDay = day;
        }
      } else {
        total.set(p, { hits: n, msgs: 1, days: 1, lastDay: day });
      }
    }
  }
  return total;
}

/**
 * 造一个「把昵称抹掉」的函数。
 *
 * 空字符串必须挡掉：`split("")` 会把整句话拆成单字，
 * 那样**所有**片段都消失 —— 而表现是「所有人都没有口头禅」，
 * 没有任何地方看得出哪里错了。名册里混进一个空名字是很常见的。
 */
function scrubber(names: readonly string[]): (text: string) => string {
  /*
   * 除了完整昵称，**前缀也要抹**。
   *
   * 群里叫人很少叫全名：「牛牛酱」在对话里就是「牛牛」。
   * 只抹全名的话「牛牛你看」原样留下，于是「牛牛你」成了他的口头禅 ——
   * 那仍然是个名字。
   *
   * 只抹前缀不抹后缀：前缀是称呼的常见形态（「小明同学」→「小明」），
   * 而后缀多半是通名（「同学」「老师」），抹掉会误伤一批正常的话。
   */
  const withPrefixes = names.flatMap((n) => {
    const chars = [...n];
    const out = [n];
    for (let len = 2; len < chars.length; len++) out.push(chars.slice(0, len).join(""));
    return out;
  });
  const real = [...new Set(withPrefixes)].filter((n) => n.length > 0);
  if (real.length === 0) return (text) => text;
  // 长的先替换，避免「牛牛」先把「牛牛酱」切开
  real.sort((a, b) => b.length - a.length);
  return (text) => {
    let out = text;
    // 换成一个标点：它会在抽片段时断开，等于在那里打了个断点
    for (const name of real) out = out.split(name).join("，");
    return out;
  };
}

export interface CatchphraseInput {
  /** 这个人说过的话，**按时间排好** */
  mine: readonly Said[];
  /**
   * 基准：同群其他人的片段统计。
   *
   * 传**算好的统计**而不是原文，因为基准对整个群只有一份 ——
   * 每个人都重算一遍的话，一个群十二个人就要把三万条消息翻十二遍。
   * 实测那样是每人 27 秒，而算一次基准给所有人用是几秒。
   */
  others: Map<string, PhraseStat>;
  /** 基准里一共有多少条消息 */
  otherMessages: number;
  /**
   * 要排除的字串：群成员昵称。
   *
   * 群里天天喊的名字频率极高，而那是别人的名字，不是他的口头禅。
   */
  exclude?: readonly string[];
}

/**
 * 挑一个。挑不出来返回 `null` —— **挑不出来是常态，不是失败**。
 *
 * 说话少的人、说话和大家一样的人，本来就没有口头禅。
 * 硬凑一个出来只会得到一句谁看了都觉得不像的话，
 * 而那会让人怀疑这一整块区域。
 */
export function pickCatchphrase(input: CatchphraseInput): Catchphrase | null {
  if (input.mine.length < MIN_MESSAGES) return null;

  /*
   * 昵称在**抽片段之前**就从原文里抹掉。
   *
   * 事后按「片段包含昵称」筛是不够的：「牛牛酱你看」里的「牛牛你」
   * 既不包含完整昵称、也不被昵称包含，照样漏出去。
   * 而它明显还是那个名字的一部分。
   *
   * 从原文抹掉相当于在那里打一个断点，跨过名字的片段自然就不存在了 ——
   * 一次处理干净，不必再想有多少种重叠方式。
   */
  const scrub = scrubber(input.exclude ?? []);
  const mine = tally(input.mine.map((m) => ({ text: scrub(m.text), day: m.day })));
  const others = input.others;

  /*
   * 基准的分母用「别人说了多少条消息」，不是「多少个片段」。
   *
   * 用片段数的话，长消息多的群基准会被稀释 —— 同一个词在爱写长文的群里
   * 会显得更「独特」，而那只是因为分母大。按消息条数算的是
   * 「平均每条消息里出现几次」，两边可比。
   */
  const myMsgs = input.mine.length;
  const otherMsgs = Math.max(1, input.otherMessages);

  const candidates: Catchphrase[] = [];
  for (const [phrase, stat] of mine) {
    if (stat.hits < MIN_HITS) continue;
    if (stat.msgs < MIN_DISTINCT) continue;
    // 只在那几天里刷过 —— 那是话题，不是习惯
    if (stat.days < MIN_DAYS) continue;

    const myRate = stat.hits / myMsgs;
    /*
     * 基准有个**下限**：别人一次都没说过时，按「说过一次」算。
     *
     * 不设下限的话除数是 0，lift 变成无穷大 —— 于是一个只出现过 5 次、
     * 别人恰好一次没说的偏僻片段，会排在「他说了 300 次、别人也常说」
     * 的真口头禅前面。而前者多半只是某天某个话题的残留。
     *
     * 下限写在这里就够了，不必再给分子加一 —— 加了也会被这一步夹掉，
     * 只是让人多读一遍。
     */
    const otherRate = (others.get(phrase)?.hits ?? 0) / otherMsgs;
    const lift = myRate / Math.max(otherRate, 1 / otherMsgs);
    if (lift < MIN_LIFT) continue;

    /*
     * ═══ 只按 lift 排是不行的 ═══
     *
     * lift 天然偏爱**稀有**片段：一个他说了 5 次、别人恰好一次没说的
     * 词，lift 能到 13；而他说了 300 次、别人也常说的真口头禅只有 2.7。
     * 于是赢的永远是某天某个话题的残留 —— 「量子隧穿」打败「卧槽」。
     *
     * 所以用**使用率 × log(lift)**：前者管「他到底说得多不多」，
     * 后者管「比别人多多少」，取对数是为了让 lift 从 100 涨到 200
     * 不再和从 2 涨到 4 一样值钱 —— 到了那个量级，多独特已经不重要了。
     *
     * 这就是语料库语言学里算 keyness 的常规做法：
     * 光看频率得到的是虚词，光看独特性得到的是噪声。
     */
    const score = myRate * Math.log(lift);

    candidates.push({ phrase, hits: stat.hits, msgs: stat.msgs, days: stat.days, lift, score });
  }

  if (candidates.length === 0) return null;

  // 分数高的在前；完全打平时取长的那个（更像一句话）
  candidates.sort(
    (a, b) => b.score - a.score || b.hits - a.hits || b.phrase.length - a.phrase.length,
  );

  /*
   * 收拾互相包含的片段：如果一个更长的候选**几乎每次都跟着**出现，
   * 说明短的只是长的一部分，取长的。
   *
   * 比的是「出现在多少条**不同消息**里」，不是总次数 ——
   * 因为短的必然在长的内部重复：「哈哈哈」里有两个「哈哈」，
   * 于是按次数比永远是 2:1，长的一次都赢不了。
   * 按消息条数比才是同一个尺度：两个都是「这条消息里有没有」。
   */
  const best = candidates[0];
  const longer = candidates
    .filter(
      (c) =>
        c.phrase !== best.phrase &&
        c.phrase.includes(best.phrase) &&
        // 0.9 而不是 0.8：松一点就会把「断章取义」推成「长断章取义」
        c.msgs >= best.msgs * 0.9,
    )
    // 有多个更长的都符合时取最长的那个
    .sort((a, b) => b.phrase.length - a.phrase.length)[0];
  return longer ?? best;
}
