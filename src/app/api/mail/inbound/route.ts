import { createHmac, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { ingestMessage, type InboundMessage } from "@/lib/mail/ingest";
import {
  MAIL_PROTOCOL_MIN,
  MAIL_PROTOCOL_VERSION,
  protocolAcceptable,
} from "@/lib/mail/protocol";

export const dynamic = "force-dynamic";

/**
 * 网关把收到的每一封信投到这里。
 *
 * ═════════════════════════════════════════
 * 它不是给人用的接口，认证方式也因此不一样
 * ═════════════════════════════════════════
 *
 * 别的接口认的是「谁在调」（会话 / 令牌）。这一个认的是
 * **「这段字节确实是网关发出来的、而且没被改过」** ——
 * 因为它接受的是任意发件人的内容，而内容会直接落进用户的收件箱。
 *
 * 所以用 HMAC 签整个请求体，不用 Bearer 令牌：
 * 令牌只证明调用方知道一个秘密，签名还证明**这一份内容**没被中途换掉。
 */

const SECRET = process.env.MAIL_INGRESS_SECRET ?? "";

export async function POST(request: Request) {
  /*
   * 没配密钥时**直接关门**，不是「放行」。
   *
   * 这是那种「配置漏了一半反而更糟」的地方：放行的话，
   * 任何人都能往任意地址投递任意内容，而它看起来完全正常在工作。
   */
  if (!SECRET) {
    return NextResponse.json(
      { error: { code: "not_configured", message: "MAIL_INGRESS_SECRET 没配，收信入口关闭" } },
      { status: 503 },
    );
  }

  const raw = await request.text();
  const signature = request.headers.get("x-mail-signature") ?? "";

  if (!verify(raw, signature)) {
    return NextResponse.json(
      { error: { code: "bad_signature", message: "签名对不上" } },
      { status: 401 },
    );
  }

  let payload: InboundMessage;
  try {
    payload = JSON.parse(raw) as InboundMessage;
  } catch {
    return NextResponse.json({ error: { code: "bad_json", message: "请求体不是 JSON" } }, { status: 400 });
  }

  if (!payload?.envelopeTo || !payload?.envelopeFrom) {
    return NextResponse.json(
      { error: { code: "bad_payload", message: "缺 envelopeTo 或 envelopeFrom" } },
      { status: 400 },
    );
  }

  /*
   * 协议版本对不上就明确报错，不要「尽力解析」。
   *
   * 网关和站点是两个独立部署的东西，滚动升级时版本必然会有一段
   * 不一致的时间。尽力解析的表现是**有些信收得到、有些收不到**，
   * 而两边的日志都显示一切正常 —— 那是要查三天的那种问题。
   *
   * 回 400 而不是 500：这不是我们出错，是对面发来的东西我们不认识，
   * 而网关看到 4xx 会停下来报警，看到 5xx 会一直重投。
   */
  if (!protocolAcceptable(payload.protocol)) {
    return NextResponse.json(
      {
        error: {
          code: "protocol_mismatch",
          message: `网关协议版本 ${String(payload.protocol)} 站点不认识（站点支持 ${MAIL_PROTOCOL_MIN}–${MAIL_PROTOCOL_VERSION}）—— 升级网关`,
        },
      },
      { status: 400 },
    );
  }

  const result = ingestMessage({
    ...payload,
    size: Number(payload.size) || raw.length,
    sourceIp: request.headers.get("x-mail-source-ip"),
  });

  /*
   * 判决都返回 200。
   *
   * 网关那一侧看 `verdict` 决定给发件人回 2xx 还是 5xx ——
   * 我们这里回非 2xx 的话，网关会当成「我们挂了」然后重投，
   * 而「这个地址不存在」重投一百次结果是一样的。
   */
  return NextResponse.json(result);
}

/**
 * 比签名。
 *
 * `timingSafeEqual` 而不是 `===`：字符串比较会在第一个不同的字节
 * 上返回，而那个时间差足以让人**逐字节猜出签名**。
 * 长度不同时直接返回假 —— timingSafeEqual 长度不等会抛。
 */
function verify(body: string, signature: string): boolean {
  const expected = createHmac("sha256", SECRET).update(body).digest("hex");
  if (signature.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}
