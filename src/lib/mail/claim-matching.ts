/**
 * 「这个域名看起来是谁的」—— 纯函数，不碰数据库。
 *
 * ═════════════════════════════════════════
 * 这一层判错的代价是不对称的
 * ═════════════════════════════════════════
 *
 * 判不出来 → 域名进公共池，那个人以后再申领一个，损失是一次沟通。
 * **判错了** → 把 A 的域名发给了 B，而 B 一旦拿它注册了什么，
 * 收回来就是在动别人已经在用的东西。
 *
 * 所以这里的每一条规则都要求**强证据**，宁可漏判：
 *   · 核心串至少 5 个字符 —— 不然 `md` 这种昵称能匹配上半个池子
 *   · 只认「加/减一小段」的变体，不做编辑距离
 *   · 一个域名匹配到两个人时**一个都不给**
 */

/** 归一化：只留小写字母和数字。`Carleight Wu` → `carleightwu` */
export function normalizeHandle(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** 域名去掉后缀，只留主体 */
export function sldOf(domain: string): string {
  return domain.toLowerCase().replace(/\.[a-z]+$/, "");
}

/**
 * 核心串的最短长度。
 *
 * 5 是数出来的：库里最短的几个昵称是 `md` `DT` `Z` `a` `Lay`，
 * 而 `md` 出现在 `md5523` 里、也出现在别的域名里。
 * 低于 5 的话，匹配的是巧合不是身份。
 */
export const MIN_CORE_LENGTH = 5;

export type MatchKind =
  /** 归一化之后完全相同 —— 最强 */
  | "exact"
  /** 是某个已认领域名加/减一小段（`shipowner` → `ashipowner`）*/
  | "variant"
  /** 昵称是域名的一部分，或反过来 */
  | "contains";

export interface Candidate {
  userId: string;
  /** 用来比对的串（昵称或已认领域名的主体），原样保留，报告里要显示 */
  handle: string;
  /** 这个候选是从哪来的 —— 「凭什么是他的」要答得上 */
  source: "nickname" | "claimed-domain";
}

export interface MatchResult {
  userId: string;
  kind: MatchKind;
  /** 匹配上的那个串，写进审计和报告 */
  matched: string;
  source: Candidate["source"];
}

/**
 * 一个域名归谁。判不出来返回 null。
 *
 * ⚠ **匹配到多个不同的人时返回 null**，不是「挑最像的那个」——
 * 两个人都像的时候，挑一个的期望正确率是 50%，
 * 而这件事错一次的代价远大于漏一次。
 */
export function matchDomain(domain: string, candidates: readonly Candidate[]): MatchResult | null {
  const sld = sldOf(domain);
  const target = normalizeHandle(sld);
  if (target.length < MIN_CORE_LENGTH) return null;

  const hits: MatchResult[] = [];

  for (const c of candidates) {
    const handle = normalizeHandle(c.handle);
    if (handle.length < MIN_CORE_LENGTH) continue;

    const kind = compare(target, handle, c.source);
    if (kind) hits.push({ userId: c.userId, kind, matched: c.handle, source: c.source });
  }

  if (hits.length === 0) return null;

  // 同一个人被多条证据命中算一次
  const people = new Set(hits.map((h) => h.userId));
  if (people.size > 1) return null;

  // 取最强的那条证据当理由
  const order: MatchKind[] = ["exact", "variant", "contains"];
  return hits.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))[0];
}

function compare(target: string, handle: string, source: Candidate["source"]): MatchKind | null {
  if (target === handle) return "exact";

  /*
   * 变体只认**已认领的域名**。
   *
   * 昵称不认：`Allen` 是 `iseeyouin` 的主人，而
   * 「昵称加一小段」几乎必然误伤 —— 一个叫 `Max` 的人
   * 会匹配上任何含 `max` 的域名。
   */
  if (source === "claimed-domain") {
    const [longer, shorter] = target.length >= handle.length ? [target, handle] : [handle, target];
    /*
     * 加/减的那一段要短。
     *
     * `shipowner` → `ashipowner`（+1）、`yintins01` → `yintins`（−2）、
     * `tripfzjmr` ↔ `tripfzjmr`（去连字符后相同，走 exact）都算。
     * 而 `techcheng` → `techerng` 这种**改中间的字母**不算 ——
     * 那更可能是两个不同的词，而不是同一个人的第二个域名。
     */
    if (longer.startsWith(shorter) || longer.endsWith(shorter)) {
      const extra = longer.length - shorter.length;
      if (extra <= 3 && shorter.length >= MIN_CORE_LENGTH) return "variant";
    }
    return null;
  }

  /*
   * 昵称包含关系。
   *
   * 要求**被包含的那个也够长**：`Lay` 包含在 `layopc` 里，
   * 但 `lay` 只有 3 个字符 —— 它同样包含在 `relay`、`display` 里。
   * 上面已经用 MIN_CORE_LENGTH 挡过一次，这里是第二道。
   */
  if (target.includes(handle) || handle.includes(target)) {
    const core = Math.min(target.length, handle.length);
    if (core >= MIN_CORE_LENGTH) return "contains";
  }

  return null;
}

/** 一句给人看的理由，写进 `mail_domains.note` 和审计 */
export function explainMatch(result: MatchResult): string {
  const how =
    result.kind === "exact"
      ? "完全一致"
      : result.kind === "variant"
        ? "是已认领域名的变体"
        : "包含关系";
  const from = result.source === "nickname" ? "昵称" : "已认领的域名";
  return `按${from}「${result.matched}」匹配（${how}）`;
}
