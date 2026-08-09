/**
 * 群消息 @提及 的解析与归属 —— 纯函数，不碰数据库。
 *
 * 为什么必须在**同步落库的那一刻**解析：@后面跟的是昵称，而昵称随时会变。
 * 只存字符串的话，三个月后同一句话就指向另一个人（或者谁都不指），
 * 而且没有任何报错 —— 所以这里把昵称立即解析成 wx_id 存下来，
 * 展示时再用当前昵称渲染。
 *
 * 一条划死的线：**解析不出来就如实标 unknown / ambiguous，绝不挑一个最像的。**
 * 猜错的 @ 会把别人的话安在无关的人头上，比没有 @ 更糟。
 *
 * 形态（实测 2026-08-08，本地 4.2 万条消息 + 生产上游抽样 200 条）：
 *   - 微信选人插入的 @ 以 U+2005（四分之一 em 空格）结尾，昵称是精确的，
 *     且昵称本身可以含普通空格（"@Carleight Wu"）——所以不能用空格当定界符
 *   - 手打的 @ 没有 U+2005，边界只能靠名册反推
 *   - 邮箱和接龙里的 "jmr@nothing" 不是提及 —— @ 前面是字母数字时要跳过
 */

/** 微信在选人 @ 之后插入的定界符。普通空格不行：昵称本身可以含空格 */
export const MENTION_SEP = " ";

/** 昵称长度上限。微信群昵称最长 16 个字，放宽到 32 容错，防止把整段话吞成昵称 */
const MAX_NAME_LEN = 32;

/**
 * @所有人 的各种写法。微信按群语言渲染，中英都见过 ——
 * "Mention All" 是英文界面的形态，生产数据实测 49 次
 */
const MENTION_ALL = ["所有人", "全体成员", "all", "everyone", "mention all"];
const MENTION_ALL_SET = new Set(MENTION_ALL);

export type MentionStatus = "resolved" | "ambiguous" | "unknown" | "all";

export interface MentionRecord {
  /** @ 后面的字面昵称 —— 解析那一刻的证据，昵称改了以后这里还原当时写的是什么 */
  name: string;
  status: MentionStatus;
  /** 仅 resolved 时非空 */
  wxId: string | null;
  /** ambiguous 时的候选 wx_id，展示层据此说明"有几个同名的人"而不是选边 */
  candidates: string[];
  /** @ 在 content 里的下标。昵称可能在正文里重复出现，渲染必须按位置定位 */
  position: number;
}

export interface RosterEntry {
  wxId: string;
  /** 群内备注名（群昵称）—— 微信选人列表显示的优先形态 */
  displayName: string | null;
  /** 微信昵称 */
  wxName: string | null;
  /** 曾用名（来自改名事件）。老消息里的 @ 用的是当时的昵称，只认现名会全部失联 */
  aliases?: string[];
  /** 入群/退群时间，用来在同名冲突时排除"当时根本不在群里"的人 —— 这是证据，不是猜测 */
  joinedAt?: number | null;
  leftAt?: number | null;
}

interface Token {
  name: string;
  position: number;
  /** U+2005 定界的（微信原生 @），昵称精确可信 */
  delimited: boolean;
}

/** @ 的前一个字符是邮箱/handle 的组成部分时，这个 @ 不是提及 */
function isHandleChar(ch: string): boolean {
  return /[A-Za-z0-9._%+-]/.test(ch);
}

/** 名册名在正文里的边界字符：手打 @ 只有干净收尾时才敢认 */
function isCleanBoundary(ch: string | undefined): boolean {
  if (ch === undefined) return true;
  if (ch === MENTION_SEP) return true;
  // 空白 + 常见中英文标点。CJK 正文字符不算边界 ——
  // "@生土豆真好吃" 里没法确定昵称到哪结束，宁可不认
  return /[\s,.!?;:()[\]{}'"，。！？；：（）【】《》、…~～]/.test(ch);
}

/**
 * 词法扫描：找出所有 @ 起始的候选提及。
 *
 * U+2005 定界的直接取到定界符为止；手打的先不定边界（名字留空），
 * 交给 resolveMentions 拿名册去反推 —— 词法层猜边界必然猜错，
 * 中文正文与昵称之间没有任何分隔。
 */
export function extractMentionTokens(content: string): Token[] {
  const tokens: Token[] = [];

  for (let i = 0; i < content.length; i++) {
    if (content[i] !== "@") continue;
    if (i > 0 && isHandleChar(content[i - 1])) continue;

    const rest = content.slice(i + 1);
    const sepIdx = rest.indexOf(MENTION_SEP);
    const nlIdx = rest.indexOf("\n");

    if (sepIdx > 0 && sepIdx <= MAX_NAME_LEN && (nlIdx === -1 || sepIdx < nlIdx)) {
      tokens.push({ name: rest.slice(0, sepIdx), position: i, delimited: true });
      i += sepIdx + 1;
      continue;
    }

    tokens.push({ name: "", position: i, delimited: false });
  }

  return tokens;
}

/** 一个人所有可用于匹配的名字，按可信度分层 */
function namesOf(member: RosterEntry): { primary: string | null; secondary: string[] } {
  const display = member.displayName?.trim() || null;
  const wx = member.wxName?.trim() || null;
  // 微信 @ 选人列表显示的是群备注名（没设则微信昵称），插入的就是这个
  const primary = display ?? wx;
  const secondary: string[] = [];
  if (display && wx && wx !== display) secondary.push(wx);
  for (const alias of member.aliases ?? []) {
    const t = alias.trim();
    if (t && t !== primary && !secondary.includes(t)) secondary.push(t);
  }
  return { primary, secondary };
}

/** 这个人在消息发出的时刻可能在群里吗？时间未知时从宽 —— 排除只凭证据 */
function plausibleAt(member: RosterEntry, ts: number | undefined): boolean {
  if (ts === undefined) return true;
  if (member.joinedAt != null && member.joinedAt > ts) return false;
  if (member.leftAt != null && member.leftAt < ts) return false;
  return true;
}

function judge(
  hits: RosterEntry[],
  name: string,
  position: number,
  ts: number | undefined,
): MentionRecord {
  const distinct = [...new Map(hits.map((m) => [m.wxId, m])).values()];

  if (distinct.length === 1) {
    return { name, status: "resolved", wxId: distinct[0].wxId, candidates: [], position };
  }

  // 同名的人不止一个：先用入退群时间排除当时不在群里的 ——
  // 这是可核验的事实。剩下仍多于一个才是真歧义。
  const plausible = distinct.filter((m) => plausibleAt(m, ts));
  if (plausible.length === 1) {
    return { name, status: "resolved", wxId: plausible[0].wxId, candidates: [], position };
  }

  const pool = plausible.length > 0 ? plausible : distinct;
  return {
    name,
    status: "ambiguous",
    wxId: null,
    candidates: pool.map((m) => m.wxId),
    position,
  };
}

/** 精确名匹配：先比选人列表显示的形态，比不上再放宽到昵称/曾用名 */
function matchExact(roster: RosterEntry[], name: string): RosterEntry[] {
  const primary = roster.filter((m) => namesOf(m).primary === name);
  if (primary.length > 0) return primary;
  return roster.filter((m) => namesOf(m).secondary.includes(name));
}

/**
 * 手打 @ 的边界反推：拿名册里每个名字去比 @ 后面的正文前缀。
 * 取最长命中，且命中后必须干净收尾（空白/标点/结尾）——
 * 名册里有 "jmr" 不代表 "@jmrx" 是在 @ 他。
 */
function matchPrefix(
  roster: RosterEntry[],
  content: string,
  position: number,
): { name: string; hits: RosterEntry[] } | null {
  const after = content.slice(position + 1);
  let best: { name: string; hits: RosterEntry[] } | null = null;

  for (const member of roster) {
    const { primary, secondary } = namesOf(member);
    for (const name of [primary, ...secondary]) {
      if (!name || name.length > after.length) continue;
      if (!after.startsWith(name)) continue;
      if (!isCleanBoundary(after[name.length])) continue;
      if (!best || name.length > best.name.length) {
        best = { name, hits: [member] };
      } else if (name.length === best.name.length && name === best.name) {
        best.hits.push(member);
      }
    }
  }

  return best;
}

/**
 * 解析一条消息里的全部 @。
 *
 * ts 是消息时间戳，只用于同名冲突时的在群时段排除；
 * 不传则跳过该步（歧义如实保留）。
 */
export function resolveMentions(
  content: string,
  roster: RosterEntry[],
  ts?: number,
): MentionRecord[] {
  const records: MentionRecord[] = [];

  for (const token of extractMentionTokens(content)) {
    if (token.delimited) {
      const lowered = token.name.trim().toLowerCase();
      if (MENTION_ALL_SET.has(lowered)) {
        records.push({
          name: token.name,
          status: "all",
          wxId: null,
          candidates: [],
          position: token.position,
        });
        continue;
      }

      const hits = matchExact(roster, token.name);
      if (hits.length === 0) {
        // 定界了却对不上名册：多半是被 @ 的人后来改了名或退了群。
        // 如实标 unknown，字面昵称留作证据
        records.push({
          name: token.name,
          status: "unknown",
          wxId: null,
          candidates: [],
          position: token.position,
        });
      } else {
        records.push(judge(hits, token.name, token.position, ts));
      }
      continue;
    }

    // 没有定界符的 @所有人（手打的，或定界符被输入法吃掉的）——
    // 生产数据里实测存在，按 all 处理而不是 unknown
    const after = content.slice(token.position + 1);
    const allHit = MENTION_ALL.find(
      (kw) =>
        after.toLowerCase().startsWith(kw) && isCleanBoundary(after[kw.length]),
    );
    if (allHit) {
      records.push({
        name: after.slice(0, allHit.length),
        status: "all",
        wxId: null,
        candidates: [],
        position: token.position,
      });
      continue;
    }

    // 手打 @：没有定界符，只有名册反推出的边界才可信
    const matched = matchPrefix(roster, content, token.position);
    if (matched) {
      records.push(judge(matched.hits, matched.name, token.position, ts));
      continue;
    }

    /*
     * 名册也对不上的手打 @：连昵称的边界都无法确定。
     * 截一小段当字面证据（到空白/行尾，封顶 MAX_NAME_LEN），标 unknown。
     * 截出来是空的（"@ " 或行尾孤零零一个 @）就不算提及。
     */
    const rough = content
      .slice(token.position + 1)
      .split(/[\s ]/, 1)[0]
      .slice(0, MAX_NAME_LEN);
    if (!rough) continue;
    records.push({
      name: rough,
      status: "unknown",
      wxId: null,
      candidates: [],
      position: token.position,
    });
  }

  return records;
}
