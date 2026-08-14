/**
 * 查一个域名的 MX / SPF / DMARC 配对了没有。
 *
 * ═════════════════════════════════════════
 * 为什么走 DoH，而不是系统的 DNS
 * ═════════════════════════════════════════
 *
 * 很多网络（包括这个项目的开发机所在的那个）对 **53 端口做透明劫持**：
 * 不存在的域名会被返回一个 `198.18.x.x` 的假地址，
 * 而且 **`dig @1.1.1.1` 也一样** —— 查询根本没出去，
 * 指定哪个服务器都没用。
 *
 * 后果不是「查不到」，是**查到假的**：一个还没建的记录看起来已经建好了。
 * 8-14 核对那一百个域名时就是这么撞上的。
 *
 * DoH 走 443，劫不了。
 *
 * ═════════════════════════════════════════
 * 两家一起问
 * ═════════════════════════════════════════
 *
 * 记录刚加、TTL 又短的时候，同一家解析器的不同节点缓存都不同步 ——
 * 实测 Google 说 `bluecat.icu` 没有 MX，而 Cloudflare 同一秒能查到。
 *
 * 只问一家就会报出一堆并不存在的「缺记录」，而人会真的跑去 DNSPod
 * 重加一遍。所以**任一家查到就算有**。
 */

export type DnsAnswer = { type: number; data: string };

export interface Resolver {
  /** 返回 null 表示这一次没查成（超时、限流），和「查到了但没有记录」不是一回事 */
  (name: string, type: "MX" | "TXT"): Promise<DnsAnswer[] | null>;
}

export interface DnsVerdict {
  domain: string;
  mxOk: boolean | null;
  spfOk: boolean | null;
  dmarcOk: boolean | null;
  /** 查到的原文，排查时要看 */
  detail: { mx: string[]; spf: string[]; dmarc: string[] };
}

/** 域名转 A 标签 —— DNS 上只认这个形态 */
export function asciiName(domain: string): string {
  const lower = domain.trim().toLowerCase();
  if (/^[a-z0-9.-]+$/.test(lower)) return lower;
  try {
    return new URL(`http://${lower}`).hostname;
  } catch {
    return lower;
  }
}

/**
 * 判定。
 *
 * `null` 是「没查成」，**不是「没配」** —— 两者混在一起的话，
 * 一次网络抖动会让后台把一百行标成红灯，然后没有人再相信那些灯。
 */
export async function checkDomainDns(
  domain: string,
  mxHost: string,
  resolvers: readonly Resolver[],
): Promise<DnsVerdict> {
  const name = asciiName(domain);

  const askAll = async (target: string, type: "MX" | "TXT") => {
    const results = await Promise.all(resolvers.map((r) => r(target, type)));
    const usable = results.filter((r): r is DnsAnswer[] => r !== null);
    // 一家都没查成 → null；任一家查到就合并
    if (usable.length === 0) return null;
    return usable.flat().map((a) => a.data);
  };

  const [mx, txt, dmarc] = await Promise.all([
    askAll(name, "MX"),
    askAll(name, "TXT"),
    askAll(`_dmarc.${name}`, "TXT"),
  ]);

  // 比对时把两边的末尾点都去掉 —— MX 的值带点，设置里的通常不带
  const want = mxHost.toLowerCase().replace(/\.$/, "");
  const strip = (s: string) => s.toLowerCase().replace(/\.$/, "").replace(/^"|"$/g, "");

  return {
    domain,
    mxOk: mx === null ? null : mx.some((m) => strip(m).endsWith(want)),
    spfOk: txt === null ? null : txt.some((t) => strip(t).startsWith("v=spf1")),
    dmarcOk: dmarc === null ? null : dmarc.some((t) => strip(t).startsWith("v=dmarc1")),
    detail: { mx: mx ?? [], spf: txt ?? [], dmarc: dmarc ?? [] },
  };
}

/** 一家 DoH 解析器。`endpoint` 形如 `https://dns.google/resolve` */
export function dohResolver(endpoint: string, timeoutMs = 15_000): Resolver {
  return async (name, type) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`${endpoint}?name=${encodeURIComponent(name)}&type=${type}`, {
          headers: { accept: "application/dns-json" },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) continue;
        const body = (await res.json()) as { Status?: number; Answer?: DnsAnswer[] };
        /*
         * Status 0 = 有答案，3 = NXDOMAIN（域名/记录确实不存在）。
         * 两者都是**查成了**，返回数组（可能是空的）。
         * 别的状态（2 SERVFAIL、5 REFUSED…）是没查成，重试。
         */
        if (body.Status === 0 || body.Status === 3) {
          return (body.Answer ?? []).filter((a) => a.type === 15 || a.type === 16);
        }
      } catch {
        /* 超时或网络错，重试 */
      }
    }
    return null;
  };
}

/** 默认两家。任一家查到就算有 —— 理由见文件顶上 */
export const DEFAULT_RESOLVERS: readonly Resolver[] = [
  dohResolver("https://dns.google/resolve"),
  dohResolver("https://cloudflare-dns.com/dns-query"),
];
