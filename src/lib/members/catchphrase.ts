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

/**
 * 至少这么大比例的出现要落在句子边界上。
 *
 * 39k 条真实消息上量出来的边界率分布：
 *
 *   话题词  智能 0.0% / 公益站 0.0% / 香港 0.8% / 域名 1.1%
 *   功能词  可以 2.0% / 然后 4.2% / 哈哈哈 5.8% / 所以 6.8%
 *   口头禅  离谱 16.1% / 确实 19.1% / 卧槽 65.4%
 *
 * 5% 卡在功能词中间：挡掉全部话题词，也挡掉「可以」「然后」，
 * 而放过「哈哈哈」—— 后者是真口头禅，只是常写成「哈哈哈哈哈」
 * 被四字窗口切在中间，边界率被稀释了。
 *
 * **不做停用词表**：「然后」对某些人就是真口头禅（「然后…然后…」），
 * 停用词会把一个人最显著的特征一刀切掉。区分他和别人的不是这个词，
 * 是他说得比别人多多少 —— 那件事 lift 在管。
 */
export const MIN_EDGE_RATE = 0.05;

/**
 * 或者：至少这么大比例的**消息**里，它自己就是全部内容。
 *
 * ═════════════════════════════════════════
 * 这是分开「口头禅」和「话题词」最锋利的一刀
 * ═════════════════════════════════════════
 *
 * 线上整条率：
 *
 *   神了 94% / 绷 92% / 草 89% / 笑死我了 88% / wow 86% / nb 79%
 *   卧槽 66% / 确实 52% / 我靠 49% / 我去 35%
 *   —— 而 claude、api、gpt、香港、域名 全都接近 0
 *
 * 它对中文和字母**同时**成立，所以放开字母之后不会被品牌词淹掉。
 *
 * 15% 离两边都很远，所以这条线不敏感：调到 10% 或 25% 结论几乎一样。
 * 一个需要精调的门槛说明信号选错了。
 */
export const MIN_SOLO_RATE = 0.15;

export interface PhraseStat {
  /** 总共出现多少次 */
  hits: number;
  /** 其中有多少次落在句子边界上 —— 见 phrasesWithEdge */
  edgeHits: number;
  /** 有多少**条**消息里它自己就是全部内容 */
  soloHits: number;
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

/** 先把链接整段拿掉 —— 不然 `https` `github` `com` 会成为高频「口头禅」 */
const URL = /https?:\/\/\S+|www\.\S+/g;

export interface PhraseHit {
  phrase: string;
  /** 这次出现贴着句子边界（段首或段尾）。**字母串恒为 false**，见下 */
  edge: boolean;
  /** 这次出现时，它自己就是一整条消息 —— 最强的那个信号 */
  standalone: boolean;
}

/**
 * 一条消息里的表情。
 *
 * ═════════════════════════════════════════
 * 两种表情，**一半原来被整个忽略了**
 * ═════════════════════════════════════════
 *
 * 微信里有两套：
 *
 *   · 自带表情，同步下来是 `[旺柴]` 这种方括号词
 *   · **真的 Unicode emoji**（😭🤔🐟），就是普通字符
 *
 * 原来只认前一种。线上量了三万条：方括号 1604 个、
 * **Unicode 1394 个** —— 也就是说差不多一半的表情从来没被统计过，
 * 而且被漏掉的那些个人特色更强（某个人光 🐟 就发了 150 次）。
 *
 * ─────────────────────────────────────────
 * 为什么不能只匹配单个码点
 * ─────────────────────────────────────────
 *
 * `👨‍👩‍👧` 是三个人形用 ZWJ 连起来的，`👍🏽` 是手势加肤色修饰符。
 * 按单码点切的话，一个「全家」会被数成三次「人」，
 * 而肤色会变成一个单独的表情。所以要连着 ZWJ 和修饰符一起吃掉。
 */
const UNICODE_EMOJI =
  /\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*/gu;

export function emojiOf(text: string): string[] {
  return [
    ...(text.match(BRACKET) ?? []).map((s) => s.slice(1, -1)),
    ...(text.match(UNICODE_EMOJI) ?? []),
  ];
}

/**
 * 一条消息 → 里面所有 2–4 字的汉字片段。
 *
 * 只认汉字连续段：URL、代码、数字都在这一步被切开，不必再单独排除。
 * 方括号表情先摘掉（见 BRACKET）。
 */
export function phrasesWithEdge(text: string): PhraseHit[] {
  const cleaned = text.replace(URL, " ").replace(BRACKET, "，");
  /*
   * 整条消息去掉尾部语气符之后剩什么 —— 用来判「这个片段是不是
   * 自己就是一整条消息」。「草。」「草！」和「草」是同一件事。
   */
  const whole = cleaned.trim().toLowerCase().replace(/[。！？~…\s]+$/u, "");

  const out: PhraseHit[] = [];

  /*
   * 汉字连续段和**字母串**都要。
   *
   * 字母原来整段被丢掉，理由是「一个人的口头禅不可能是 https」——
   * 那句话对 URL 成立，但把 `uwu` / `orz` / `xswl` / `nb` 一起误伤了，
   * 而它们恰恰是最有个人特色的那一类。正确做法是先去掉 URL（上面那行），
   * 而不是禁掉字母。
   */
  for (const run of cleaned.match(/[一-鿿]+|[A-Za-z]{2,8}/g) ?? []) {
    const latin = !/[一-鿿]/.test(run);
    const chars = [...run];

    if (latin) {
      /*
       * 字母串不切 n-gram：`claude` 切出来的 `laud` 不是任何人的口头禅。
       *
       * ⚠ `edge` 恒为 **false**，不是 true。
       *
       * 第一版写成 true，线上重算之后榜首直接变成 `der` `ude` `dex`
       * `ck`（lift 高到 2455）—— 全是被昵称清洗切碎的单词残片
       * （codex → dex、claude → ude），又短又稀有所以 lift 爆表。
       *
       * 原因：中文里的字母串本来就被空格包着，「贴着边界」对它们
       * **恒成立**，于是这一位不携带任何信息，而它同时是门槛的一条 ——
       * 等于所有字母串免检放行。
       *
       * 字母串只能靠**整条率**过门槛：`uwu` `nb` `wow` 常常自己就是
       * 一整条消息，而 `dex` 永远不会。
       */
      const phrase = run.toLowerCase();
      out.push({ phrase, edge: false, standalone: whole === phrase });
      continue;
    }

    for (let len = MIN_LEN; len <= MAX_LEN; len++) {
      for (let i = 0; i + len <= chars.length; i++) {
        const phrase = chars.slice(i, i + len).join("");
        out.push({
          phrase,
          // 段首或段尾 —— 两头都算，「确实……」和「……确实」都是口头禅的样子
          edge: i === 0 || i + len === chars.length,
          standalone: whole === phrase,
        });
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
    const here = new Map<string, { n: number; edge: number; solo: number }>();
    for (const { phrase, edge, standalone } of phrasesWithEdge(text)) {
      const cur = here.get(phrase) ?? { n: 0, edge: 0, solo: 0 };
      cur.n += 1;
      if (edge) cur.edge += 1;
      // 「整条」按**消息**算：一条消息只可能整体等于它一次
      if (standalone) cur.solo = 1;
      here.set(phrase, cur);
    }
    for (const [p, { n, edge, solo }] of here) {
      const cur = total.get(p);
      if (cur) {
        cur.hits += n;
        cur.edgeHits += edge;
        cur.soloHits += solo;
        cur.msgs += 1;
        if (cur.lastDay !== day) {
          cur.days += 1;
          cur.lastDay = day;
        }
      } else {
        total.set(p, { hits: n, edgeHits: edge, soloHits: solo, msgs: 1, days: 1, lastDay: day });
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
/*
 * 这里本来有个 `pickCatchphrase`（只回冠军一个）。
 * 改成给 3～5 个之后，生产里没有任何地方再调它 ——
 * 仓库那条「只有测试在用的导出」守卫拦下了，拦得对：
 * `pickCatchphrases(input)[0]` 就是同一件事，多一个导出
 * 就多一处将来会和另一处分叉的判定。
 */

/** 全部够格的候选，按分数排好。上面两个入口共用这一份 */
function rankCatchphrases(input: CatchphraseInput): Catchphrase[] {
  if (input.mine.length < MIN_MESSAGES) return [];

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
    /*
     * ═════════════════════════════════════════
     * 「有个人特色」不等于「说得最多」
     * ═════════════════════════════════════════
     *
     * 站长的原话：「不一定是最多说的，比如草草草、我服惹、uwu、摸摸你
     * 这种，很有个人特色的」。
     *
     * 而原来是 `使用率 × log(lift)` —— 使用率**线性**，于是它压倒一切：
     * 说了三百次的「可以」永远赢过说了二十次的「卧槽」。
     * 线上算出来的因此是「香港」「域名」「智能」「公益站」这种话题词。
     */
    const edgeRate = stat.edgeHits / stat.hits;
    const soloRate = stat.soloHits / stat.msgs;

    /*
     * 两个信号**任一**达标即可，不是都要达标。
     *
     * 用「或」：`uwu` 整条率很高但从不出现在句子中间，「然后」正相反。
     * 要求都达标等于只留中间那一类，而那类恰恰最没意思。
     */
    if (soloRate < MIN_SOLO_RATE && edgeRate < MIN_EDGE_RATE) continue;

    /*
     * 频次改成**对数** —— 这是「不一定是最多说的」那句话的落点。
     *
     * 频次仍然要算（说过五次的成不了口头禅，那是偶然），但不该压倒一切。
     * 取对数之后 300 次和 30 次的差距从十倍缩到两倍多，
     * 于是「说得多」不再自动赢过「说得怪」。
     *
     * 整条率权重给到 3：它是三个信号里唯一一个能一眼认出
     * 「这是个语气词」的。
     */
    const score = Math.log(1 + stat.hits) * Math.log(lift) * (1 + 3 * soloRate + edgeRate);

    candidates.push({ phrase, hits: stat.hits, msgs: stat.msgs, days: stat.days, lift, score });
  }

  if (candidates.length === 0) return [];

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
  /*
   * ── 先过滤，再挑冠军 ─────────────────────────
   *
   * 原来这一步**只作用在冠军一个身上**：挑出分最高的，再看有没有
   * 更长的可以把它顶上去。那挡不住残片当冠军 —— 线上真出现过：
   * ShipOwner 的口头禅被算成「工智能」（644 次），
   * 而它是「人工智能」被切掉一个字的残片；还有「音极速版」
   * （抖音极速版）、「蛋笨」。
   *
   * 残片能过边界门槛是因为**长词的后缀天然贴着段尾** ——
   * 「人工智能」里的「工智能」结束在段尾，edge 恒成立。
   * 门槛因此对这一类完全失效。
   *
   * 改成先把所有被更长候选吸收掉的短片段整个删掉，再排名。
   */
  const survivors = candidates.filter(
    (c) =>
      /*
       * ⚠ 在**整个 tally** 里找更长的，不是只在通过了门槛的候选里找。
       *
       * 第一版只看 candidates，于是「工智能」照样当上了冠军 ——
       * 线上实测它和「人工智能」的 hits/msgs 一模一样（644 / 31），
       * 本该被吸收，但「人工智能」自己没进候选集，于是残片没人管。
       *
       * 「这是不是残片」是**文本的性质**，不该取决于长的那个
       * 有没有通过门槛。
       */
      ![...mine.entries()].some(
        ([phrase, longer]) =>
          phrase !== c.phrase &&
          phrase.includes(c.phrase) &&
          /*
           * 0.9 而不是 0.8：松一点就会把「断章取义」推成「长断章取义」。
           *
           * 比的是**出现在多少条不同消息里**，不是总次数 ——
           * 短的必然在长的内部重复（「哈哈哈」里有两个「哈哈」），
           * 按次数比永远是 2:1，长的一次都赢不了。
           * 按消息条数比才是同一个尺度：两个都是「这条消息里有没有」。
           */
          longer.msgs >= c.msgs * 0.9,
      ),
  );

  // 全被吸收掉是不可能的（最长的那个没人能吸收它），但兜一下底
  return survivors.length > 0 ? survivors : candidates;
}

/**
 * 同上，但给**前几个**。
 *
 * ═════════════════════════════════════════
 * 为什么一个不够
 * ═════════════════════════════════════════
 *
 * 站长：「常说的词怎么还有一个，3～5 个左右」。
 *
 * 一个词说不出一个人的样子 —— 「卧槽」只说明他会惊讶。
 * 三到五个放在一起才有轮廓：「卧槽 / 确实 / 笑死 / 没绷住」
 * 是一种人，「确实 / 所以说 / 本质上 / 反过来」是另一种。
 *
 * 上限五个不是随手定的：再多就会开始出现勉强过线的候选，
 * 而**一个明显不像的词会让旁边四个也显得不可信**。
 *
 * 去重那一步（互相包含的吸收掉）在这里比单个时更要紧：
 * 前五名很容易是同一个词的五种切法（「哈哈」「哈哈哈」「哈哈哈哈」…），
 * 那样看起来就像算法坏了。
 */
export function pickCatchphrases(input: CatchphraseInput, limit = 5): Catchphrase[] {
  const ranked = rankCatchphrases(input);
  if (ranked.length === 0) return [];

  /*
   * 再去一次重：排名靠前的那几个里，把**互相包含**的收掉。
   *
   * 上面那一步吸收的是「被更长的完全盖住」的；这里要防的是另一种 ——
   * 「笑死」和「笑死我了」都活了下来，各自都够格，但一起出现是废话。
   * 保留先出现的（分更高的）那个。
   */
  const out: Catchphrase[] = [];
  for (const c of ranked) {
    if (out.some((kept) => kept.phrase.includes(c.phrase) || c.phrase.includes(kept.phrase))) {
      continue;
    }
    out.push(c);
    if (out.length >= limit) break;
  }
  return out;
}
