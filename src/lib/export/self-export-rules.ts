/**
 * 「导出我自己的数据」的规则层。纯函数，不碰数据库。
 *
 * ═════════════════════════════════════════
 * 「自己的数据」这条线划在哪
 * ═════════════════════════════════════════
 *
 * 这个功能是**最容易破掉站内隐私约束的地方** —— 一份 zip 落到本地
 * 之后，站里那套「群列表只对同群的人可见」就再也管不着它了。
 * 所以这条线必须先划清楚，再写代码：
 *
 * ① **自己发的话，全都是自己的。**
 *    包括他现在已经退掉的群里发过的话 —— 那是他写下的东西，
 *    退群不改变它的归属。
 *
 * ② **别人发的话，不是他的资产；但没有它，他自己的话没有意义。**
 *    「@我一下」单独拎出来是废数据，前后那几条才让它成为可训练的对话。
 *    站长明确要求「含上下文」，所以上下文必须给。给的边界是：
 *
 *      **只给他此刻在站内本来就读得到的东西。**
 *
 *    也就是 `visibleGroupIds()` 那一套：他当前仍在、且已接入本站的群。
 *    导出不新增任何可见性 —— 它只是把他已经能看的东西换个格式装走。
 *    退了的群：自己的话照导，上下文不给（他现在打开归档页也看不到）。
 *
 * ③ **上下文里的人做假名化。**
 *    正文原样保留（改了就不是上下文了），但发言人的 wx_id 和昵称一律
 *    换成 `p1` `p2` 这样的代号。理由不是「这样就没有隐私问题了」——
 *    正文里照样可能有名字。理由是：**身份标识符是可以拿去连接别的
 *    数据集的**，昵称和 wx_id 一旦落到本地就成了跨库对齐的钥匙，
 *    而正文只是文本。同一个人在同一份导出里始终是同一个代号，
 *    所以对话仍然是可训练的；跨两次导出不通用，防止拿多份拼人物图谱。
 *
 * ④ **群名只给他当前看得见的群。**
 *    看不见的群只留一个 conv_id —— 他知道自己在哪发过话，
 *    但导出不替他把「有哪些群、叫什么」写下来。
 *
 * ⑤ **没有任何「导出某某人」的参数。** 主体永远是发起人自己，
 *    从会话里取，不从请求里取。连预览态（管理员以他人身份浏览）
 *    也要拦下来 —— 那正好是一个「以别人的身份导出别人数据」的口子。
 *
 * ═════════════════════════════════════════
 * 这仍然是一份含有他人发言的数据集
 * ═════════════════════════════════════════
 *
 * 上面四条把范围收到了「他本来就能看到的」，但收不到零。
 * 所以 README 和界面文案里都必须把这句话说明白，
 * 而不是让人下载完才发现里面有别人的话。
 */

/** 一段「自己连续说话」之间允许的最大间隔。超过就断成两段 */
export const RUN_GAP_MS = 5 * 60_000;

/** 一段自己的话最多含多少条 —— 只是为了给内存一个上界，超了就断开另起一段 */
export const RUN_MAX_OWN = 50;

/** 每段前后各取多少条别人的话作为上下文 */
export const CONTEXT_BEFORE = 5;
export const CONTEXT_AFTER = 5;

/**
 * 上下文的时间上限。
 *
 * 只按「前后 5 条」取的话，一个冷清的群里「前一条」可能是三天前的 ——
 * 那不是上下文，那是另一场对话，混进训练集里只会制造噪声。
 */
export const CONTEXT_WINDOW_MS = 10 * 60_000;

/** 一段窗口（含上下文）最多多少条，防刷屏把一段撑爆 */
export const WINDOW_MAX_MESSAGES = 200;

/**
 * 一次导出最多多少条自己的消息。
 *
 * 不是怕内存 —— 那边是流式的。是怕**时间**：每段窗口要跑三次查询，
 * 一个请求跑十分钟对谁都没好处。超了就按时间从新到旧截断，
 * 并在 manifest 和 README 里如实写明截断了多少。
 */
export const MAX_OWN_MESSAGES = 50_000;

/** 每次向数据库要多少条自己的消息。分页的粒度，也是内存的上界 */
export const MESSAGE_BATCH = 500;

/** 论坛内容同样分批取 */
export const FORUM_BATCH = 200;

/* ───────────────────────────────────────────────────────────────
 * 限流
 * ─────────────────────────────────────────────────────────────── */

/**
 * 两次导出之间的最小间隔。
 *
 * 生成一份导出是重活：几万条消息、每段三次查询、外加 deflate。
 * 那台机器只有 3.7G，而且这个接口是**登录用户就能点**的 ——
 * 不限流的话，一个人按住 F5 就能把站压垮，不需要任何恶意。
 *
 * 半小时这个数是这么来的：导出的内容一天之内基本不变，
 * 真有人要重下，等半小时不算刁难；而它足以让「反复点」失去意义。
 */
export const EXPORT_MIN_GAP_MS = 30 * 60_000;

/** 一天最多几次。防的是「每半小时挂个脚本跑一次」 */
export const EXPORT_DAILY_CAP = 3;

export const EXPORT_DAY_MS = 86_400_000;

export interface RateVerdict {
  allowed: boolean;
  message: string;
  retryAfterSeconds: number;
}

/**
 * 限流判定。输入是这个人最近若干次导出的**发起时间**。
 *
 * 记的是发起而不是完成：一次跑到一半崩掉的导出照样消耗了那台机器的
 * 时间片，不该因为它失败了就白送一次重试。
 */
export function exportRateVerdict(recentStarts: number[], now: number): RateVerdict {
  const withinDay = recentStarts.filter((t) => now - t < EXPORT_DAY_MS);

  if (withinDay.length >= EXPORT_DAILY_CAP) {
    const oldest = Math.min(...withinDay);
    const wait = Math.ceil((oldest + EXPORT_DAY_MS - now) / 1000);
    return {
      allowed: false,
      message: `今天已经导出 ${withinDay.length} 次了，明天再来`,
      retryAfterSeconds: Math.max(wait, 1),
    };
  }

  const last = withinDay.length > 0 ? Math.max(...withinDay) : null;
  if (last !== null && now - last < EXPORT_MIN_GAP_MS) {
    const wait = Math.ceil((last + EXPORT_MIN_GAP_MS - now) / 1000);
    return {
      allowed: false,
      message: `刚导出过，${Math.ceil(wait / 60)} 分钟后可以再导一次`,
      retryAfterSeconds: Math.max(wait, 1),
    };
  }

  return { allowed: true, message: "", retryAfterSeconds: 0 };
}

/* ───────────────────────────────────────────────────────────────
 * 假名
 * ─────────────────────────────────────────────────────────────── */

/**
 * 把 wx_id 换成本次导出内稳定的代号。
 *
 * 按**首次出现顺序**发号，不做哈希 —— 哈希给不了额外的保护
 * （能拿到导出的人就是能拿到原始 wx_id 的那个人），却会让
 * 数据变得没法读。顺序号还有个好处：`p1` 出现得最早，
 * 翻数据时一眼能看出谁是主要对话人。
 *
 * 上界是社群人数（千级），不是消息数 —— 所以它可以一直留在内存里。
 */
export interface Pseudonyms {
  /** 自己永远是 self，绝不发代号 */
  labelFor(wxId: string | null | undefined): string;
  size(): number;
}

export const SELF_LABEL = "self";

export function createPseudonyms(selfWxId: string | null): Pseudonyms {
  const map = new Map<string, string>();
  return {
    labelFor(wxId) {
      if (!wxId) return "unknown";
      if (selfWxId && wxId === selfWxId) return SELF_LABEL;
      const existing = map.get(wxId);
      if (existing) return existing;
      const label = `p${map.size + 1}`;
      map.set(wxId, label);
      return label;
    },
    size: () => map.size,
  };
}

/* ───────────────────────────────────────────────────────────────
 * 切段
 * ─────────────────────────────────────────────────────────────── */

export interface OwnMessageRef {
  id: string;
  convId: string;
  ts: number;
}

export interface MessageRun<T extends OwnMessageRef = OwnMessageRef> {
  convId: string;
  startTs: number;
  endTs: number;
  /** 这一段里自己发的消息，原样带着 —— 不含上下文时它就是整段内容 */
  own: T[];
}

/**
 * 把「自己发的消息」切成一段一段。
 *
 * ─────────────────────────────────────────
 * 为什么不是「每条消息各配 5 条上下文」
 * ─────────────────────────────────────────
 *
 * 那种做法有两个毛病，而且都很致命：
 *
 * 1. 连着刷了 10 条的人，会得到 10 份互相重叠 90% 的片段 ——
 *    喂进训练集就是同一段对话重复十遍，那是数据污染，不是数据。
 * 2. 每条消息两次查询。四万条就是八万次，一个 HTTP 请求扛不住。
 *
 * 按「同一个群 + 间隔不超过 GAP」切段之后，一段配一次上下文：
 * 片段之间不重叠，查询次数降到段数级别，而且产出的正好是
 * **一整段连续对话** —— 那才是「上下文」这个词本来的意思。
 *
 * 输入必须按 (convId, ts, id) 排好序。这是流式的：来一条判一条，
 * 内存里最多只有当前这一段（且封顶 RUN_MAX_OWN 条）。
 */
export async function* runsOf<T extends OwnMessageRef>(
  own: AsyncIterable<T> | Iterable<T>,
  gapMs: number = RUN_GAP_MS,
  maxOwn: number = RUN_MAX_OWN,
): AsyncGenerator<MessageRun<T>> {
  let current: MessageRun<T> | null = null;

  for await (const msg of own) {
    const continues =
      current !== null &&
      current.convId === msg.convId &&
      msg.ts - current.endTs <= gapMs &&
      current.own.length < maxOwn;

    if (current && continues) {
      current.endTs = msg.ts;
      current.own.push(msg);
      continue;
    }

    if (current) yield current;
    current = { convId: msg.convId, startTs: msg.ts, endTs: msg.ts, own: [msg] };
  }

  if (current) yield current;
}

/* ───────────────────────────────────────────────────────────────
 * 输出格式
 * ─────────────────────────────────────────────────────────────── */

/**
 * 一行一个 JSON 对象。
 *
 * 选 JSONL 而不是一个大 JSON 数组：几万条的数组要整份读进内存才能解析，
 * 而这份东西是拿去喂模型的，处理它的脚本多半是逐行流式读的。
 * JSON.stringify 会把正文里的换行转义成 \n，所以「一行一条」这件事
 * 不会被消息内容破坏。
 */
export function jsonl(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/** 文件名带日期 —— 一个人会导好几次，全叫 export.zip 的话分不清哪份是哪次 */
export function exportFilename(date: string): string {
  return `我的数据-${date}.zip`;
}

/** 包内路径。**全是 ASCII** —— 中文路径在部分解压器里会变成乱码目录 */
export const FILES = {
  readme: "README.md",
  manifest: "manifest.json",
  profile: "profile.json",
  messages: "messages.jsonl",
  posts: "forum-posts.jsonl",
  replies: "forum-replies.jsonl",
  drafts: "forum-drafts.jsonl",
  interactions: "forum-interactions.jsonl",
} as const;

export interface ExportCounts {
  ownMessages: number;
  contextMessages: number;
  windows: number;
  posts: number;
  replies: number;
  drafts: number;
  interactions: number;
  /** 上下文里出现的人数（去重后的代号数） */
  pseudonyms: number;
  /** 撞到 MAX_OWN_MESSAGES 上限被截断了 */
  truncated: boolean;
}

export const emptyCounts = (): ExportCounts => ({
  ownMessages: 0,
  contextMessages: 0,
  windows: 0,
  posts: 0,
  replies: 0,
  drafts: 0,
  interactions: 0,
  pseudonyms: 0,
  truncated: false,
});

export interface ManifestInput {
  exportedAt: number;
  /** 东八区的可读时间 */
  exportedAtLocal: string;
  userId: string;
  withContext: boolean;
  counts: ExportCounts;
  visibleGroups: number;
}

/**
 * manifest：给**程序**读的那一份。
 * README 给人读，两份内容重合是故意的 —— 三个月后翻出这个包的人，
 * 可能是个人，也可能是个脚本。
 */
export function buildManifest(input: ManifestInput) {
  return {
    format: "agenticlab-self-export",
    formatVersion: 1,
    exportedAt: input.exportedAt,
    exportedAtLocal: input.exportedAtLocal,
    subjectUserId: input.userId,
    withContext: input.withContext,
    limits: {
      maxOwnMessages: MAX_OWN_MESSAGES,
      contextBefore: CONTEXT_BEFORE,
      contextAfter: CONTEXT_AFTER,
      contextWindowMs: CONTEXT_WINDOW_MS,
      runGapMs: RUN_GAP_MS,
      windowMaxMessages: WINDOW_MAX_MESSAGES,
    },
    counts: input.counts,
    visibleGroups: input.visibleGroups,
    files: {
      [FILES.profile]: "自己的账号信息，单个 JSON 对象",
      [FILES.messages]: "群聊。一行一个「窗口」对象，见 README",
      [FILES.posts]: "自己发的论坛主题帖，一行一帖",
      [FILES.replies]: "自己发的论坛回复，一行一条",
      [FILES.drafts]: "自己的服务端草稿，一行一条",
      [FILES.interactions]: "收藏 / 表态 / 投票，一行一条，用 kind 区分",
    },
    notice:
      "本文件含他人在群聊与论坛中的公开发言（已做假名化）。转发、公开或用于训练前，请自行承担相应责任。",
  };
}

/**
 * README：给**人**读的那一份。
 *
 * 一份没有说明的数据集，三个月后连导出的人自己都不知道那些字段是什么 ——
 * 于是它会被原样再导一次，或者干脆被当成垃圾删掉。
 * 所以这一份不是客套，它是这个 zip 里最长寿的文件。
 */
export function buildReadme(input: ManifestInput): string {
  const ctx = input.withContext
    ? `含上下文：**是**。每段自己的发言前后各附最多 ${CONTEXT_BEFORE}/${CONTEXT_AFTER} 条同群消息（且不超过 ${CONTEXT_WINDOW_MS / 60_000} 分钟）。`
    : "含上下文：**否**。只有自己发的消息。";

  return `# 我的数据导出

导出时间：${input.exportedAtLocal}（东八区）
账号 ID：${input.userId}
格式版本：agenticlab-self-export v1

${ctx}

---

## 这里面有别人的发言

群聊是多个人一起说的话。**只保留自己那几条，剩下的对谁都没有意义** ——
所以这份导出里必然出现别人的发言。范围是这样划的：

- 只导**你当前仍然在、且已接入本站的群**的上下文。退掉的群里你自己说过的话照样在，
  但那些群的上下文不给 —— 你现在打开站内归档也看不到它们。
- 上下文里的人一律**假名化**：\`p1\`、\`p2\`……同一个人在这份导出里始终是同一个代号，
  但**跨两份导出不通用**。他们的 wx_id 和昵称不在这份文件里。
- 发言**正文原样保留**。改了就不叫上下文了 —— 也就是说，正文里仍可能出现人名。

**这份东西怎么用，责任在你。** 公开、转发、上传到第三方平台之前，
请想清楚里面还有别人说过的话。

## 文件

| 文件 | 是什么 |
| --- | --- |
| \`${FILES.profile}\` | 你的账号信息（单个 JSON 对象） |
| \`${FILES.messages}\` | 群聊，一行一个「窗口」 |
| \`${FILES.posts}\` | 你发的主题帖 |
| \`${FILES.replies}\` | 你发的回复 |
| \`${FILES.drafts}\` | 你的服务端草稿 |
| \`${FILES.interactions}\` | 收藏 / 表态 / 投票 |
| \`${FILES.manifest}\` | 上面这些的机器可读版本 + 条数统计 |

\`.jsonl\` = 每行一个独立的 JSON 对象，**不是**一个 JSON 数组。
这样几十兆的文件也能一行一行流式读，不必整份塞进内存：

\`\`\`python
import json
with open("messages.jsonl", encoding="utf-8") as f:
    for line in f:
        window = json.loads(line)
\`\`\`

## \`${FILES.messages}\` 的字段

一行是一个**窗口** —— 一段连续对话，而不是一条消息。
切段规则：同一个群、相邻自己发言间隔不超过 ${RUN_GAP_MS / 60_000} 分钟。

\`\`\`json
{
  "conv": "群的内部 id，稳定但无含义",
  "group": "群名；你当前看不到的群这里是 null",
  "startTs": 1700000000000,
  "endTs": 1700000090000,
  "selfCount": 2,
  "truncated": false,
  "messages": [
    {
      "speaker": "self | p1 | p2 | bot | unknown",
      "self": true,
      "ts": 1700000000000,
      "type": "text",
      "text": "消息正文",
      "hasMedia": false,
      "quality": true,
      "role": "context | own"
    }
  ]
}
\`\`\`

- \`ts\` 是毫秒时间戳（UTC 纪元）。站内一切时间显示按东八区。
- \`speaker\` 为 \`self\` 的就是你。\`bot\` 是社群机器人自己发的。
- \`role\`：\`own\` = 你发的，\`context\` = 为了让它读得懂而附上的别人的话。
- \`type\` 是上游的消息类型（\`text\` / \`image\` / \`quote\` …）。非文本类型的
  \`text\` 字段可能是一段 XML —— 那是上游原样给的，没有加工。
- \`truncated\` 为真表示这一段里的消息超过 ${WINDOW_MAX_MESSAGES} 条，中间被截断了。

## \`${FILES.replies}\` 里的 \`context\`

一条回复脱离原帖同样读不懂，所以每条回复带上原帖的标题和摘要。
**但只在你现在仍然看得见那个帖子的时候给** —— 看不见的写成
\`"context": null\` 加一个 \`contextReason\`，而不是悄悄留空。

## 已知的边界

- 单次最多导出 ${MAX_OWN_MESSAGES.toLocaleString("en-US")} 条自己的消息。超出时按时间**从新到旧**保留，
  \`${FILES.manifest}\` 里的 \`counts.truncated\` 会是 \`true\`。
- 群聊记录本身受站内的分层保留策略影响，太旧的消息可能已经不在库里了。
- 附件、图片、语音的**二进制内容不在这份导出里**，只有一个 \`hasMedia\` 标记。
`;
}
