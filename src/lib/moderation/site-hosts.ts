import "server-only";

import { env } from "@/lib/env";

import { DEFAULT_SITE_HOSTS } from "./link-defang-rules";

/**
 * 本站算哪些域名。
 *
 * 「外链」的反面是「站内」，而站内是什么得看部署 —— 本地开发是
 * localhost:3000，线上是正式域名。写死一个的话，本地调试时站内链接
 * 会被当外链拆掉，而那种「只在我机器上不对」最费时间。
 *
 * 解析不出来时退回默认表而不是抛错：一个环境变量填歪了不该让整个
 * 论坛的正文渲染不出来。
 */
export function siteHosts(): string[] {
  const hosts = [...DEFAULT_SITE_HOSTS];
  try {
    const host = new URL(env.site.url).hostname.toLowerCase();
    if (host && !hosts.includes(host)) hosts.push(host);
  } catch {
    // 配歪了就只用默认表
  }
  return hosts;
}
