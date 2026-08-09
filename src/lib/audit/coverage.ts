/**
 * 审计覆盖检查。纯函数，输入是源码文本。
 *
 * ─────────────────────────────────────────
 * 「靠自觉一定会漏」
 * ─────────────────────────────────────────
 *
 * SCHEMA.md 第十节自己写着这句话，而这套东西直到现在**就是靠自觉**：
 * 每个后台写操作都要记 `audit()`，但没有任何东西在检查。
 *
 * 真正的运行时拦截层做不出来 —— drizzle 的写入没有统一入口，
 * 硬套一层代理只会得到一堆「谁在写」说不清楚的记录。
 * 而说不清楚是谁写的审计日志，比没有更糟：它会让人以为查过了。
 *
 * 所以退一步，做**编译期的静态检查**：
 * 一个函数只要调了 `requireAdmin` 又做了写操作，
 * 就必须调 `audit(` / `audited(`，或者把写委托给某个自己会记账的模块。
 *
 * 这个检查抓不到「记了但记错了」，只抓「压根没记」。
 * 后者是这类问题里占绝大多数的那种。
 */

export interface AuditGap {
  file: string;
  fn: string;
  reason: string;
  line: number;
}

/** 写操作的特征 —— drizzle 与裸 SQL 两种写法 */
const WRITE_PATTERNS = [
  /\.insert\(/,
  /\.update\(/,
  /\.delete\(/,
  /\bsqlite\.prepare\([^)]*\b(INSERT|UPDATE|DELETE)\b/i,
  /\.run\(\)/,
];

/*
 * 直接往 auditLogs 表里写也算记了账。
 *
 * settings/store.ts 就是这么做的 —— 它要把配置、历史、审计三张表
 * 放进同一个事务，走 audit() 那个独立写入会破坏事务边界。
 * 只认 audit() 的话会把一段**记得比大多数地方都完整**的代码判成漏记。
 */
const AUDIT_PATTERNS = [/\baudit\(/, /\baudited\(/, /\bauditLogs\b/];

/**
 * 把源码按顶层 `export async function` / `export function` 切成块。
 *
 * 用括号配平找函数体尾，而不是靠缩进 —— 缩进在 prettier 改一次
 * 配置之后就会全变。
 */
export interface FunctionBlock {
  name: string;
  body: string;
  line: number;
  isAsync: boolean;
}

export function splitFunctions(source: string): FunctionBlock[] {
  const out: FunctionBlock[] = [];
  const header = /export\s+(async\s+)?function\s+(\w+)/g;

  for (const match of source.matchAll(header)) {
    const start = match.index ?? 0;
    const braceStart = bodyStart(source, start);
    if (braceStart === -1) continue;

    let depth = 0;
    let end = braceStart;
    let quote: string | null = null;

    for (let i = braceStart; i < source.length; i++) {
      const char = source[i];
      if (quote) {
        if (char === quote && source[i - 1] !== "\\") quote = null;
        continue;
      }
      if (char === '"' || char === "'" || char === "`") {
        quote = char;
        continue;
      }
      if (char === "{") depth++;
      else if (char === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }

    out.push({
      name: match[2],
      body: source.slice(braceStart, end + 1),
      line: source.slice(0, start).split("\n").length,
      isAsync: Boolean(match[1]),
    });
  }
  return out;
}

/**
 * 找到函数体真正开始的那个 `{`。
 *
 * 不能直接取函数名之后第一个 `{` —— 参数上的内联对象类型
 * （`function f(input: { a: string })`）会先撞上，
 * 于是「函数体」变成了那段类型声明，里面当然没有任何写操作。
 *
 * 这个 bug 让检查器**静默漏报**：所有带内联参数类型的后台函数
 * 全都被判成「没有写操作」而跳过 —— 而这个项目里几乎每个
 * server action 都是那么写的。一个只对简单函数生效的检查器，
 * 和没有检查器差不多。
 */
function bodyStart(source: string, from: number): number {
  // 先跳过参数列表
  const parenStart = source.indexOf("(", from);
  if (parenStart === -1) return -1;

  let depth = 0;
  let i = parenStart;
  for (; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")") {
      depth--;
      if (depth === 0) break;
    }
  }

  // 再跳过返回类型：`): Promise<{ ok: boolean }> {` 里的 { 在尖括号内
  let angle = 0;
  for (i += 1; i < source.length; i++) {
    const char = source[i];
    if (char === "<") angle++;
    else if (char === ">") angle = Math.max(0, angle - 1);
    else if (char === "{" && angle === 0) return i;
  }
  return -1;
}

export function hasWrite(body: string): boolean {
  return WRITE_PATTERNS.some((re) => re.test(body));
}

export function hasAudit(body: string): boolean {
  return AUDIT_PATTERNS.some((re) => re.test(body));
}

export function requiresAdmin(body: string): boolean {
  return /requireAdmin\(/.test(body);
}

/**
 * 允许把记账委托出去的调用。
 *
 * 这些函数自己内部会记 —— 在调用方再记一次只会产生两条重复日志，
 * 而重复日志会让「这件事发生过几次」变得说不清。
 *
 * 加进这张表要慎重：写错一个名字，就等于给某个函数发了永久豁免 ——
 * 而豁免是静默的：它不报错，只是从此不再检查那一片。
 *
 * 这不是假设。第一版凭印象写了个 `executeApproval`，
 * 而代码里根本没有这个函数 —— 测试当场把它揪了出来。
 * 所以 tests/audit-coverage.test.ts 会**逐个核对这些名字真的存在、
 * 而且真的会记账**。
 */
export const DELEGATES = [
  // 配置变更那一整套（历史、回滚、审计）都在 changeSetting 里
  "changeSetting",
  "rollbackSetting",
  "resetSetting",
  // 配置、历史、审计三张表在同一个事务里写完
  "updateSetting",
] as const;

export function delegatesAudit(body: string): string | null {
  for (const name of DELEGATES) {
    if (new RegExp(`\\b${name}\\(`).test(body)) return name;
  }
  return null;
}

/**
 * 明确不需要审计的：只读、或者写的是「谁看过什么」这类无害记录。
 *
 * 用**函数名白名单**而不是「看起来像只读就放过」——
 * 后者会在某个函数将来加上写操作时静默失效。
 */
export const READ_ONLY_ALLOWLIST = new Set([
  "previewEligibility",
  "readNotificationPrefs",
  "recentChanges",
  "createPruneTask", // 只出预览，落一行 awaiting_confirm 的任务，执行时才记
]);

export function auditGaps(file: string, source: string): AuditGap[] {
  const gaps: AuditGap[] = [];

  for (const fn of splitFunctions(source)) {
    if (!requiresAdmin(fn.body)) continue;
    if (READ_ONLY_ALLOWLIST.has(fn.name)) continue;
    if (!hasWrite(fn.body)) continue;
    if (hasAudit(fn.body)) continue;
    if (delegatesAudit(fn.body)) continue;

    gaps.push({
      file,
      fn: fn.name,
      line: fn.line,
      reason: "调了 requireAdmin 又做了写操作，但没有 audit()",
    });
  }

  return gaps;
}
