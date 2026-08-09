/**
 * 资格引擎。纯函数，声明式规则。
 *
 * ─────────────────────────────────────────
 * 为什么要做成声明式的
 * ─────────────────────────────────────────
 *
 * 每个活动的门槛都不一样，写成代码的话每加一个活动就要改一次核心。
 * 写成 JSON 之后，规则能存进库、能在后台改、能**实时算出符合条件的有几人**。
 *
 * 最后那一条是这套东西存在的主要理由：60 个名额，
 * 你需要在开放**之前**就知道是 500 人抢 60 个，还是只有 12 个人够格。
 * 前者要考虑抽签，后者说明门槛定高了 —— 而这两种情况的应对完全相反。
 *
 * ─────────────────────────────────────────
 * 判定必须能解释
 * ─────────────────────────────────────────
 *
 * 只回答「够格 / 不够格」是不够的。限量活动里最容易吵的就是
 * 「凭什么他能申请我不能」，所以每条规则都要给出
 * **「你 34 条，要求 50 条」**这样的具体差距。
 */

export type Op = ">=" | ">" | "<=" | "<" | "==" | "!=";

export interface MetricRule {
  metric: string;
  op?: Op;
  value: number | string | string[];
  /** 统计窗口，如 30d。不填表示全期 */
  window?: string;
  label?: string;
}

export interface AllRule {
  all: Rule[];
}
export interface AnyRule {
  any: Rule[];
}
export interface NotRule {
  not: Rule;
}

export type Rule = MetricRule | AllRule | AnyRule | NotRule;

/** 一个人的各项指标。由调用方查好传进来 —— 引擎不碰数据库 */
export type Stats = Record<string, number | string | string[] | undefined>;

export interface RuleOutcome {
  passed: boolean;
  /** 一句人话，说清楚差在哪 */
  message: string;
  /** 差距，用于排序「还差多少」 */
  gap?: number;
  /**
   * 进度条画什么。只有数值型规则有。
   *
   * 有了「12 / 20」这两个数，界面才画得出一条进度条 ——
   * 而一句「只有 12，要求至少 20」在手机上是一行会被忽略的小字。
   */
  current?: number;
  target?: number;
  /**
   * 「满足其一」时各条路各自的情况。
   *
   * 折叠成一句「以下条件需满足其一：…」的话，人得在一行长句子里
   * 自己找哪条最接近 —— 而这正是他唯一想知道的事。
   */
  anyOf?: RuleOutcome[];
}

export interface EligibilityResult {
  eligible: boolean;
  outcomes: RuleOutcome[];
  /** 没过的那几条 */
  failures: RuleOutcome[];
}

export const METRIC_LABELS: Record<string, string> = {
  messages: "群里的发言数",
  quality_messages: "高质量发言数",
  active_days: "活跃天数",
  streak: "连续打卡天数",
  level: "等级",
  points: "当前积分",
  points_total: "累计获得积分",
  bound_since: "绑定日期",
  in_group: "所在群",
  has_role: "身份组",
  forum_posts: "论坛发帖数",
  forum_quality_posts: "论坛认真写的帖子数（100 字以上、不灌水）",
  forum_replies: "论坛回复数",
  checkins: "打卡天数",
};

export function metricLabel(metric: string): string {
  return METRIC_LABELS[metric] ?? metric;
}

const OP_LABELS: Record<Op, string> = {
  ">=": "至少",
  ">": "多于",
  "<=": "至多",
  "<": "少于",
  "==": "等于",
  "!=": "不等于",
};

function isMetricRule(rule: Rule): rule is MetricRule {
  return "metric" in rule;
}

function compare(actual: number, op: Op, expected: number): boolean {
  switch (op) {
    case ">=":
      return actual >= expected;
    case ">":
      return actual > expected;
    case "<=":
      return actual <= expected;
    case "<":
      return actual < expected;
    case "==":
      return actual === expected;
    case "!=":
      return actual !== expected;
  }
}

function evaluateMetric(rule: MetricRule, stats: Stats): RuleOutcome {
  const label = rule.label ?? metricLabel(rule.metric);
  const actual = stats[rule.metric];

  /*
   * 指标缺失时**判为不通过**，而不是当成 0 或直接放行。
   *
   * 当成 0 会误伤（数据还没算出来的人被当成不合格）；
   * 直接放行更糟 —— 一个拼错的指标名会让所有人都够格，
   * 而这件事在开放前的人数预估里完全看不出来。
   */
  if (actual === undefined) {
    return { passed: false, message: `缺少「${label}」这项数据，无法判定` };
  }

  // 集合型：in_group / has_role
  if (Array.isArray(rule.value)) {
    const owned = Array.isArray(actual) ? actual : [String(actual)];
    const hit = rule.value.some((v) => owned.includes(v));
    return {
      passed: hit,
      message: hit ? `${label}符合要求` : `${label}不在允许范围内`,
    };
  }

  if (typeof rule.value === "string") {
    // 日期型：bound_since <= "2026-07-25"
    const actualStr = String(actual);
    const op = rule.op ?? "<=";
    const passed =
      op === "<=" ? actualStr <= rule.value : op === ">=" ? actualStr >= rule.value : actualStr === rule.value;
    return {
      passed,
      message: passed
        ? `${label}符合要求`
        : `${label}是 ${actualStr}，要求${OP_LABELS[op]} ${rule.value}`,
    };
  }

  const op = rule.op ?? ">=";
  const actualNum = typeof actual === "number" ? actual : Number(actual);
  if (!Number.isFinite(actualNum)) {
    return { passed: false, message: `「${label}」的数据异常，无法判定` };
  }

  const passed = compare(actualNum, op, rule.value);
  const windowText = rule.window ? `${describeWindow(rule.window)}` : "";

  return {
    passed,
    // 给出具体差距 —— 「你 34 条，要求 50 条」比「不够格」有用得多
    message: passed
      ? `${windowText}${label} ${actualNum}，达标`
      : `${windowText}${label}只有 ${actualNum}，要求${OP_LABELS[op]} ${rule.value}`,
    gap: passed ? 0 : Math.abs(rule.value - actualNum),
    // 只有「至少多少」这种才画得出进度条：「至多」画出来是反的
    ...(op === ">=" || op === ">" ? { current: actualNum, target: rule.value } : {}),
  };
}

function describeWindow(window: string): string {
  const match = /^(\d+)d$/.exec(window);
  if (match) return `最近 ${match[1]} 天的`;
  return "";
}

export function evaluateRule(rule: Rule, stats: Stats): RuleOutcome[] {
  if (isMetricRule(rule)) return [evaluateMetric(rule, stats)];

  if ("all" in rule) {
    return rule.all.flatMap((r) => evaluateRule(r, stats));
  }

  if ("any" in rule) {
    const outcomes = rule.any.flatMap((r) => evaluateRule(r, stats));
    const passed = outcomes.some((o) => o.passed);

    /*
     * 把各条路原样带出去（anyOf）。
     *
     * 只折叠成一句话的话，人得在一行长句子里自己找哪条最接近 ——
     * 而「哪条最接近」正是他唯一想知道的事。
     */
    return [
      {
        passed,
        message: passed ? "满足其中一项条件" : "下面几条达成任意一条即可",
        anyOf: outcomes,
        // 差距取最小的那条 —— 排序时该按「离够格最近的那条路」算
        gap: passed ? 0 : Math.min(...outcomes.map((o) => o.gap ?? Infinity)),
      },
    ];
  }

  // not
  const inner = evaluateRule(rule.not, stats);
  const innerPassed = inner.every((o) => o.passed);
  return [
    {
      passed: !innerPassed,
      message: innerPassed ? `不满足排除条件：${inner[0]?.message ?? ""}` : "不在排除范围内",
    },
  ];
}

export function evaluateEligibility(rule: Rule | null | undefined, stats: Stats): EligibilityResult {
  // 没配规则 = 人人可参加。这是明确的语义，不是遗漏
  if (!rule) {
    return { eligible: true, outcomes: [{ passed: true, message: "本活动没有资格限制" }], failures: [] };
  }

  const outcomes = evaluateRule(rule, stats);
  const failures = outcomes.filter((o) => !o.passed);

  return { eligible: failures.length === 0, outcomes, failures };
}

/** 规则本身合不合法 —— 配错的规则会让所有人都够格或都不够格 */
export function validateRule(rule: unknown): { ok: boolean; error?: string } {
  if (rule === null || rule === undefined) return { ok: true };
  if (typeof rule !== "object") return { ok: false, error: "规则必须是对象" };

  const r = rule as Record<string, unknown>;

  if ("metric" in r) {
    if (typeof r.metric !== "string" || r.metric.length === 0) {
      return { ok: false, error: "metric 必须是非空字符串" };
    }
    if (!(r.metric in METRIC_LABELS)) {
      // 拼错的指标名会让所有人都判为不够格，而这在预估人数时看不出原因
      return { ok: false, error: `未知指标「${r.metric}」` };
    }
    if (r.value === undefined) return { ok: false, error: "缺少 value" };
    return { ok: true };
  }

  for (const key of ["all", "any"] as const) {
    if (key in r) {
      if (!Array.isArray(r[key])) return { ok: false, error: `${key} 必须是数组` };
      if ((r[key] as unknown[]).length === 0) {
        return { ok: false, error: `${key} 不能为空 —— 空的 all 会让所有人通过` };
      }
      for (const child of r[key] as unknown[]) {
        const verdict = validateRule(child);
        if (!verdict.ok) return verdict;
      }
      return { ok: true };
    }
  }

  if ("not" in r) return validateRule(r.not);

  return { ok: false, error: "规则必须包含 metric / all / any / not 之一" };
}
