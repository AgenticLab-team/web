import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { deliverableAddress, mailRoutingSnapshot } from "@/lib/mail/routing";

export const dynamic = "force-dynamic";

/**
 * 网关问路：哪些域名收信、哪个地址真的存在。
 *
 * ═════════════════════════════════════════
 * 为什么要有这个，而不是让网关直接连库
 * ═════════════════════════════════════════
 *
 * 网关跑在**另一台机器**上（源站 IP 不能出现在 MX 记录里）。
 * 让它连库意味着把数据库暴露到公网，或者再拉一条隧道 ——
 * 而它需要的只有两个问题的答案。
 *
 * ═════════════════════════════════════════
 * 两种问法，对应两种时机
 * ═════════════════════════════════════════
 *
 * · 不带参数 = **快照**：哪些域名在收信、哪些开了 catch-all。
 *   网关每分钟拉一次，绝大多数垃圾投递在这一层就被拒了 ——
 *   域名不在名单上，连一次 HTTPS 都不用打。
 *
 * · 带 `?address=` = **单点查**：快照说不准的那些（具体地址）。
 *   必须有这一条：一个人刚开的一次性箱要**立刻**能收信，
 *   而他多半是开完就去某个网站点了「发送验证码」。
 *   只靠每分钟刷新的快照的话，头一分钟内的验证码全都收不到 ——
 *   而那正是这个功能唯一的使用场景。
 */

const SECRET = process.env.MAIL_INGRESS_SECRET ?? "";

export async function GET(request: Request) {
  if (!SECRET) {
    return NextResponse.json({ error: "MAIL_INGRESS_SECRET 没配" }, { status: 503 });
  }
  if (!authorized(request)) {
    /*
     * 这个接口能回答「某个地址存不存在」—— 也就是说它**是一个
     * 地址枚举接口**。不挡住的话，任何人都能把池子里的地址扫一遍，
     * 拿去卖给垃圾邮件发送者。
     */
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const address = new URL(request.url).searchParams.get("address");
  if (address) {
    return NextResponse.json({ address, deliverable: deliverableAddress(address) });
  }

  return NextResponse.json(mailRoutingSnapshot());
}

function authorized(request: Request): boolean {
  const header = request.headers.get("authorization") ?? "";
  const token = /^Bearer\s+(\S+)$/i.exec(header.trim())?.[1] ?? "";
  if (token.length !== SECRET.length) return false;
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(SECRET));
  } catch {
    return false;
  }
}
