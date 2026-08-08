import type { ActivityModule } from "@/lib/activities/types";

/**
 * 模块①：域名发放。
 *
 * 本期形态（按需求）：**只做登记**。
 * 够格的人登记一个 ≥5 字符的域名，系统检查是否已被注册，
 * 未注册则进等待列表；管理员后续统一注册，回填成功或失败。
 *
 * 所以这个模块只实现三件事：表单、校验、描述 ——
 * 履约是人工的，框架负责状态流转和通知。
 */

export interface DomainPayload {
  /** 用户填的域名主体部分，不含后缀 */
  name: string;
  /** 选择的后缀 */
  tld: string;
  /** 备用名，首选被占时用 */
  alternate?: string;
}

/** 域名主体的最小长度。短域名值钱，不该在免费活动里放出去 */
export const MIN_DOMAIN_LENGTH = 5;
export const MAX_DOMAIN_LENGTH = 63;

/**
 * 域名主体的合法形态。
 *
 * 规则来自 RFC 1035 + IDN 的实际约束：
 *   - 只允许小写字母、数字、连字符
 *   - 不能以连字符开头或结尾
 *   - **不能在第 3、4 位同时是连字符**（`xn--` 是 punycode 前缀，
 *     普通域名占用它会导致解析歧义）
 */
const SHAPE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * 归一化用户填的域名。
 *
 * 只做**明显不改变意图**的处理：去首尾空白、转小写、去掉多填的后缀。
 *
 * ⚠️ **不去掉中间的空格。** 把「hello world」变成「helloworld」
 * 看似贴心，实际上是替用户改了他要的东西 ——
 * 他想要的多半是「hello-world」，而域名一旦注册就是永久的。
 * 这种情况要报错让他自己改，不能猜。
 */
export function normalizeDomainName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    // 人会连后缀一起填进来，而输入框旁边已经有后缀选择器了
    .replace(/\.[a-z.]+$/, "");
}

export interface DomainCheck {
  ok: boolean;
  error?: string;
  normalized?: string;
}

export function checkDomainName(raw: string, allowedTlds: string[], tld: string): DomainCheck {
  const name = normalizeDomainName(raw);

  if (name.length < MIN_DOMAIN_LENGTH) {
    return {
      ok: false,
      error: `至少 ${MIN_DOMAIN_LENGTH} 个字符 —— 更短的域名值钱，不在这次放出的范围里`,
    };
  }
  if (name.length > MAX_DOMAIN_LENGTH) return { ok: false, error: `最多 ${MAX_DOMAIN_LENGTH} 个字符` };

  if (!SHAPE.test(name)) {
    return { ok: false, error: "只能用小写字母、数字和连字符，且不能以连字符开头或结尾" };
  }

  // xn-- 是 punycode 的保留前缀，普通域名占用它会导致解析歧义
  if (name.length > 4 && name[2] === "-" && name[3] === "-") {
    return { ok: false, error: "第 3、4 位不能同时是连字符（那是国际化域名的保留前缀）" };
  }

  if (!allowedTlds.includes(tld)) {
    return { ok: false, error: `后缀只能选 ${allowedTlds.join(" / ")}` };
  }

  return { ok: true, normalized: `${name}.${tld}` };
}

/**
 * 查域名是否已被注册。走 RDAP —— 它是 WHOIS 的标准化继任者，
 * 返回 JSON，且大多数注册局都提供。
 *
 * **查不到时返回 "unknown" 而不是 "可用"。**
 * 判成可用的话，用户会以为登记成功，而管理员真去注册时才发现被占了 ——
 * 那时失望的代价比多等一会儿大得多。
 */
export async function checkDomainAvailability(
  fqdn: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ available: boolean | "unknown"; detail: string }> {
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);

  try {
    const res = await doFetch(`https://rdap.org/domain/${encodeURIComponent(fqdn)}`, {
      signal: controller.signal,
      headers: { Accept: "application/rdap+json" },
    });

    // RDAP 的语义：404 = 没有这条注册记录 = 域名可注册
    if (res.status === 404) return { available: true, detail: "RDAP 查无记录，应该可以注册" };
    if (res.ok) return { available: false, detail: "已经被注册了" };

    return {
      available: "unknown",
      detail: `RDAP 返回 ${res.status}，查不出来 —— 需要人工确认`,
    };
  } catch (error) {
    return {
      available: "unknown",
      detail: `查询失败：${error instanceof Error ? error.message : String(error)} —— 需要人工确认`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export const domainModule: ActivityModule<DomainPayload> = {
  key: "domain",
  label: "域名发放",
  description: "登记一个域名，管理员统一注册后交付",

  fields: [
    {
      name: "name",
      label: "想要的域名",
      placeholder: "例如 agentic-lab",
      hint: `至少 ${MIN_DOMAIN_LENGTH} 个字符，只能用小写字母、数字和连字符`,
      required: true,
    },
    { name: "tld", label: "后缀", required: true },
    {
      name: "alternate",
      label: "备用域名（可选）",
      hint: "首选被占时用这个 —— 填了的话可以少等一轮",
      required: false,
    },
  ],

  validate: (payload, config) => {
    const allowedTlds = Array.isArray(config.tlds) ? (config.tlds as string[]) : ["sh"];
    const result = checkDomainName(payload.name, allowedTlds, payload.tld);
    if (!result.ok) return { ok: false, error: result.error };

    // 备用名填了就一起校验 —— 等到首选被占才发现备用名也不合法就太晚了
    if (payload.alternate && payload.alternate.trim()) {
      const alt = checkDomainName(payload.alternate, allowedTlds, payload.tld);
      if (!alt.ok) return { ok: false, error: `备用域名：${alt.error}` };
    }

    return { ok: true, normalizedKey: result.normalized };
  },

  checkAvailability: (normalizedKey) => checkDomainAvailability(normalizedKey),

  describe: (payload) => {
    const main = `${normalizeDomainName(payload.name)}.${payload.tld}`;
    if (!payload.alternate?.trim()) return main;
    return `${main}（备用 ${normalizeDomainName(payload.alternate)}.${payload.tld}）`;
  },
};
