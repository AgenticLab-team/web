import { applicationStatusLabel } from "@/lib/activities/state";

/**
 * 批量回填注册结果：把管理员从注册商那边粘回来的文本，
 * 对成一份「哪些申请要标成功、哪些要标失败」的执行计划。纯函数，不碰数据库。
 *
 * ─────────────────────────────────────────
 * 为什么解析要这么宽容
 * ─────────────────────────────────────────
 *
 * 这段文本的来源是各家注册商的后台 —— 有的用逗号、有的用制表符、
 * 有的把域名写成大写、有的在末尾带个根点。管理员在微信浏览器里
 * 粘贴，中文逗号混进来是常态而不是意外。
 *
 * 格式挑剔的下场是：管理员对着一条「格式错误」逐行找哪里多了个空格，
 * 找烦了就放弃批量、回去逐条点 —— 这个功能就白做了。
 *
 * ─────────────────────────────────────────
 * 但宽容不等于猜
 * ─────────────────────────────────────────
 *
 * 认不出的状态词、同一域名两种结果 —— 这些**必须报出来而不能猜**。
 * 猜错的方向是把「失败」记成「成功」，用户收到一条「你的域名注册好了」
 * 的通知，实际上什么都没有。这里错一次，比报错一百次的代价都大。
 */

export interface ParsedEntry {
  /** 原文里的行号（从 1 起）—— 报问题时人要能对回他粘贴的东西 */
  line: number;
  /** 归一化后的完整域名 */
  domain: string;
  success: boolean;
  /** 状态词后面跟着的备注，通常是失败原因 */
  note?: string;
}

export interface ParseProblem {
  line: number;
  raw: string;
  reason: string;
}

export interface ParsedBatch {
  entries: ParsedEntry[];
  problems: ParseProblem[];
  /** 内容完全一致、被合并掉的重复域名 —— 合并是安全的，但要让人知道 */
  duplicates: string[];
}

/*
 * 状态词表。宁可词表长，也不做「包含某个字就算」的模糊匹配 ——
 * 「未成功」包含「成功」，模糊匹配会把它判成成功。
 */
const SUCCESS_WORDS = new Set([
  "成功", "已注册", "注册成功", "已成功", "已完成", "完成",
  "ok", "success", "succeeded", "done", "registered", "yes", "y", "true", "1", "√", "✓",
]);
const FAILURE_WORDS = new Set([
  "失败", "注册失败", "已被注册", "被占用", "被抢注", "占用", "溢价", "未成功",
  "fail", "failed", "failure", "error", "err", "taken", "unavailable", "premium",
  "no", "n", "false", "0", "×", "✗",
]);

/*
 * 分隔符集合：空白、制表符、半角/全角逗号、顿号、分号、冒号、竖线。
 * 冒号能进来是因为域名里不可能出现冒号 —— 但 http:// 里有，
 * 所以必须先剥掉协议前缀再按分隔符切。
 */
const SEPARATORS = /[\s,，、;；:：|]+/;

/** 域名的最低形态要求：至少「主体.后缀」。达不到的多半是粘错了列 */
const DOMAIN_SHAPE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function normalizeDomainToken(token: string): string {
  let t = token.toLowerCase().replace(/^https?:\/\//, "");
  // 注册商有时给的是链接，域名后面还挂着路径
  const slash = t.indexOf("/");
  if (slash !== -1) t = t.slice(0, slash);
  // 尾随点：DNS 根点（foo.icu.）和顺手打上的中文句号
  return t.replace(/[.。．]+$/, "");
}

/** 状态词末尾的标点不参与判断 ——「成功。」和「成功」是同一个意思 */
function normalizeStatusToken(token: string): string {
  return token.toLowerCase().replace(/[.。．,，!！~～]+$/, "");
}

export function parseFulfillText(text: string): ParsedBatch {
  const entries: ParsedEntry[] = [];
  const problems: ParseProblem[] = [];
  const duplicates: string[] = [];

  // 同一域名的多行要对到一起：先出现的那条 + 它是否已因冲突被整体作废
  const seen = new Map<string, { entry: ParsedEntry; dead: boolean }>();

  text.split(/\r?\n/).forEach((rawLine, idx) => {
    const line = idx + 1;
    // 全角空格在微信里粘出来和普通空格肉眼没有区别
    const raw = rawLine.replace(/　/g, " ").trim();
    if (!raw) return;

    const tokens = raw.replace(/^https?:\/\//i, "").split(SEPARATORS).filter(Boolean);
    if (tokens.length === 0) return;

    const domain = normalizeDomainToken(tokens[0]);
    if (!DOMAIN_SHAPE.test(domain)) {
      problems.push({ line, raw, reason: `「${tokens[0]}」认不出是域名 —— 是不是粘错了列？` });
      return;
    }

    let success = true;
    let noteStart = 1;
    if (tokens.length > 1) {
      const status = normalizeStatusToken(tokens[1]);
      if (SUCCESS_WORDS.has(status)) {
        success = true;
        noteStart = 2;
      } else if (FAILURE_WORDS.has(status)) {
        success = false;
        noteStart = 2;
      } else {
        /*
         * 认不出的状态词是硬错误，不能默认成功 ——
         * 把「待定」「pending」猜成成功，会给用户发一条兑现不了的通知。
         */
        problems.push({ line, raw, reason: `认不出状态「${tokens[1]}」—— 写「成功」或「失败」` });
        return;
      }
    }

    const note = tokens.slice(noteStart).join(" ") || undefined;
    const entry: ParsedEntry = { line, domain, success, note };

    const prev = seen.get(domain);
    if (!prev) {
      seen.set(domain, { entry, dead: false });
      entries.push(entry);
      return;
    }
    if (prev.dead || prev.entry.success !== success) {
      /*
       * 同一域名一行说成功一行说失败：两行**都不执行**。
       * 挑任何一行执行都是在替管理员做他自己都没拿定的决定，
       * 而这条写下去就会给用户发通知，收不回来。
       */
      if (!prev.dead) {
        const at = entries.indexOf(prev.entry);
        if (at !== -1) entries.splice(at, 1);
        prev.dead = true;
      }
      problems.push({
        line,
        raw,
        reason: `${domain} 和第 ${prev.entry.line} 行结果矛盾 —— 两行都没有执行，核对后重新粘贴这一条`,
      });
      return;
    }
    // 结果一致的重复行合并是安全的，但静默合并会让计数对不上，所以记下来
    if (!duplicates.includes(domain)) duplicates.push(domain);
  });

  return { entries, problems, duplicates };
}

// ── 对账：解析结果 × 系统里的申请 ─────────────────────────────

export interface AppLite {
  id: string;
  domain: string;
  status: string;
}

export interface BulkTarget {
  applicationId: string;
  domain: string;
  note?: string;
}

export interface BulkPlan {
  /** 将标记为注册成功 */
  fulfill: BulkTarget[];
  /** 将标记为注册失败（名额会还回去给候补） */
  fail: BulkTarget[];
  /** 之前已经处理过、这次结果一致 —— 跳过，不重复通知 */
  already: { domain: string; status: string }[];
  /** 系统里有这条申请，但当前状态收不下这个结果 */
  conflicts: { domain: string; reason: string }[];
  /**
   * 列表里有、系统里没有的域名。
   * **必须单独列出而不能静默丢掉**：出现它通常意味着管理员粘错了
   * 活动或粘错了列表，静默丢掉会让他以为全都处理完了。
   */
  unknown: string[];
  problems: ParseProblem[];
  duplicates: string[];
}

/** 还等着回填结果的状态 */
const AWAITING = new Set(["approved", "fulfilling"]);
/** 已经有过结果的状态 —— 再收到同样的结果就是重复提交，跳过 */
const SETTLED = new Set(["fulfilled", "failed"]);

export function planBulkFulfill(batch: ParsedBatch, apps: AppLite[]): BulkPlan {
  const plan: BulkPlan = {
    fulfill: [],
    fail: [],
    already: [],
    conflicts: [],
    unknown: [],
    problems: batch.problems,
    duplicates: batch.duplicates,
  };

  /*
   * 同一域名可能对着多条申请：唯一索引只约束「在途」的那条，
   * 旁边可能躺着更早失败或撤回的。对账要对到**在途的那条**；
   * 没有在途的，才去看已了结的判断是不是重复提交。
   */
  const byDomain = new Map<string, AppLite[]>();
  for (const app of apps) {
    const list = byDomain.get(app.domain) ?? [];
    list.push(app);
    byDomain.set(app.domain, list);
  }

  for (const entry of batch.entries) {
    const candidates = byDomain.get(entry.domain);
    if (!candidates || candidates.length === 0) {
      plan.unknown.push(entry.domain);
      continue;
    }

    const app =
      candidates.find((a) => AWAITING.has(a.status)) ??
      candidates.find((a) => SETTLED.has(a.status)) ??
      candidates[0];

    if (AWAITING.has(app.status)) {
      const target = { applicationId: app.id, domain: entry.domain, note: entry.note };
      (entry.success ? plan.fulfill : plan.fail).push(target);
      continue;
    }

    if (app.status === "fulfilled" || app.status === "failed") {
      const settledAsSuccess = app.status === "fulfilled";
      if (settledAsSuccess === entry.success) {
        // 幂等：同一份结果粘两遍不能扣两次名额、发两次通知
        plan.already.push({ domain: entry.domain, status: app.status });
      } else {
        // 结果和系统里记的相反 —— 只能人工核实，机器两边都不敢信
        plan.conflicts.push({
          domain: entry.domain,
          reason: settledAsSuccess
            ? "系统里已记为注册成功，这次却说失败 —— 需要人工核实到底注册了没有"
            : "系统里已记为注册失败。真的注册成功了的话，让申请人重新提交后再走正常履约",
        });
      }
      continue;
    }

    plan.conflicts.push({
      domain: entry.domain,
      reason: `对应申请还在「${applicationStatusLabel(app.status)}」—— 先审核通过，结果才有处落`,
    });
  }

  return plan;
}
