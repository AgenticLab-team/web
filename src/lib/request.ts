/**
 * 取客户端 IP。
 *
 * 前面只有我们自己的 nginx，它会把真实 IP 放进 X-Forwarded-For 的第一段。
 * 这个值理论上可伪造，所以只用于限流与审计展示，不用于任何鉴权判定。
 */
export function clientIp(request: Request): string | undefined {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    undefined
  );
}
