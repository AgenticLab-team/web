/**
 * 从一封邮件里把验证码抠出来。纯函数。
 *
 * ═════════════════════════════════════════
 * 为什么值得单独一个文件
 * ═════════════════════════════════════════
 *
 * 临时邮箱九成的用途是**收一个验证码**。把它抠出来放在列表行上、
 * 配一个复制按钮，用户连邮件都不用点开 —— 这是这个功能好不好用的分水岭。
 *
 * ═════════════════════════════════════════
 * 抽错一个数字，比不抽糟得多
 * ═════════════════════════════════════════
 *
 * 抽不出来的时候用户会自己点开邮件看，损失是两秒钟。
 * 抽错的时候他会**复制、粘贴、提交、被拒**，然后怀疑是网站的问题，
 * 再试一次 —— 而很多网站试错三次就锁定。
 *
 * 所以这里的每一条规则都往「宁可不抽」的方向倒：
 *   · 主题或正文里必须有验证码语境的词，否则一概不抽
 *   · 一封信里出现多个候选且**不全相同**时，不抽
 *   · 明确排除年份、金额、时间、订单号这些长得像验证码的东西
 */

/**
 * 验证码语境词。
 *
 * 没有这一层的话，任何一封带 6 位数字的邮件（订单号、快递单、
 * 账单金额）都会被当成验证码 —— 而那正是「抽错」的主要来源。
 */
const CONTEXT_WORDS = [
  // 英文
  "verification",
  "verify",
  "confirmation",
  "confirm",
  "one-time",
  "one time",
  "otp",
  "passcode",
  "security code",
  "login code",
  "sign-in code",
  "sign in code",
  "access code",
  "auth code",
  "authentication",
  "2fa",
  "two-factor",
  "your code",
  "code is",
  "code:",
  // 中文
  "验证码",
  "校验码",
  "动态码",
  "确认码",
  "登录码",
  "口令",
  "一次性密码",
];

/**
 * 候选码的形态。
 *
 * 三种，按可信度从高到低：
 *   ① 4–8 位纯数字 —— 最常见
 *   ② 6–8 位全大写字母数字混合 —— GitHub / Steam 那一类
 *   ③ 形如 `123-456` 的分段码 —— Google 用过
 *
 * 纯字母的不收：那更可能是某个单词。
 */
const CANDIDATE_PATTERNS: readonly RegExp[] = [
  /\b(\d{4,8})\b/g,
  /\b([A-Z0-9]{6,8})\b/g,
  /\b(\d{3}[-\s]\d{3})\b/g,
];

/**
 * 一定不是验证码的东西。
 *
 * 年份那一条是这里最要紧的：`2026` 完全符合「4 位数字」，
 * 而几乎每封邮件的页脚都有一个 `© 2026`。
 */
function isObviouslyNotCode(raw: string): boolean {
  const value = raw.replace(/[-\s]/g, "");

  // 年份 —— 页脚的版权行里必然有一个
  if (/^(19|20)\d{2}$/.test(value)) return true;

  // 全是同一个数字（0000、111111）—— 是占位符或分隔线，不是发给你的码
  if (/^(\d)\1+$/.test(value)) return true;

  // 纯字母（没有数字）—— 更可能是个单词
  if (!/\d/.test(value)) return true;

  return false;
}

/** 把明显不是码的上下文整段挖掉，再去找候选 */
function stripNoise(text: string): string {
  return (
    text
      // URL：里面的随机串和数字最容易被误认
      .replace(/https?:\/\/\S+/gi, " ")
      // 邮箱地址
      .replace(/\S+@\S+\.\S+/g, " ")
      // 金额（¥12345.00 / $1,234）
      .replace(/[¥$€£]\s?[\d,]+(\.\d+)?/g, " ")
      // 时间戳与日期
      .replace(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/g, " ")
      .replace(/\d{1,2}:\d{2}(:\d{2})?/g, " ")
  );
}

export interface OtpResult {
  code: string | null;
  /** 抽不出来时说明原因 —— 调试这条规则时唯一的抓手 */
  reason: string;
}

/**
 * 抽一次。
 *
 * `subject` 单独传：一半的验证码邮件把码直接写在主题里，
 * 而主题的噪声比正文小得多，所以**主题里的候选优先**。
 */
export function extractOtp(input: {
  subject?: string | null;
  bodyText?: string | null;
}): OtpResult {
  const subject = input.subject ?? "";
  const body = input.bodyText ?? "";
  const haystack = `${subject}\n${body}`;

  if (!haystack.trim()) return { code: null, reason: "没有可读的文本" };

  const lowered = haystack.toLowerCase();
  const hasContext = CONTEXT_WORDS.some((w) => lowered.includes(w));
  if (!hasContext) {
    return { code: null, reason: "没有验证码语境词，不猜" };
  }

  // 主题优先：噪声小，而且一半的码本来就在主题里
  const fromSubject = collect(subject);
  const picked = fromSubject.length > 0 ? fromSubject : collect(body);

  if (picked.length === 0) return { code: null, reason: "有语境词但找不到候选" };

  const unique = [...new Set(picked)];
  if (unique.length > 1) {
    /*
     * 多个不同的候选 —— 不抽。
     *
     * 这种信通常是「验证码 123456，订单号 998877」那一类，
     * 而挑错一个的代价是用户被目标网站锁定。
     */
    return { code: null, reason: `有 ${unique.length} 个候选，分不清哪个是` };
  }

  return { code: unique[0], reason: "抽到了" };
}

function collect(text: string): string[] {
  const clean = stripNoise(text);
  const found: string[] = [];

  for (const pattern of CANDIDATE_PATTERNS) {
    // 正则带 g，复用同一个对象会带着 lastIndex 走 —— 每次新建
    const re = new RegExp(pattern.source, pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(clean)) !== null) {
      const value = m[1];
      if (isObviouslyNotCode(value)) continue;
      found.push(value.replace(/\s/g, "-"));
    }
    // 高可信的那一档命中了就不往下找，避免混进低可信的候选
    if (found.length > 0) break;
  }

  return found;
}
