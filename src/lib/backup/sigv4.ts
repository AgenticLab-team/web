import { createHash, createHmac } from "node:crypto";

/**
 * AWS Signature V4 签名。
 *
 * 自己实现而不是装 SDK：服务器上没有 aws-cli 也没有 rclone，
 * 而这套签名一共不到一百行、有官方测试向量可以对答案。
 * 为了传几个备份文件拉进来一整个 SDK（以及它的依赖树和它的自动更新）
 * 不划算 —— 备份链路应该是这台机器上最不容易坏的东西。
 *
 * 兼容 S3 协议的对象存储都能用：Cloudflare R2、Backblaze B2、MinIO、S3 本身。
 *
 * 正确性靠 AWS 公布的 `get-vanilla` 测试向量锁住（见 tests/sigv4.test.ts）——
 * 签名算错的表现是每个请求都 403，而 403 很容易被读成「密钥填错了」，
 * 然后花一下午去查一个根本没错的密钥。
 */

const ALGORITHM = "AWS4-HMAC-SHA256";

export interface SignInput {
  method: string;
  /** 已经 URL 编码过的路径，以 / 开头 */
  path: string;
  query?: Record<string, string>;
  headers: Record<string, string>;
  /** 请求体的 SHA256 十六进制；无体时传 UNSIGNED_PAYLOAD 的哈希 */
  payloadHash: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** ISO8601 basic：20150830T123600Z */
  amzDate: string;
}

export const EMPTY_PAYLOAD_HASH = createHash("sha256").update("").digest("hex");

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/**
 * 规范化请求。
 *
 * 这一段的每个细节都会改变最终签名，而错了只会得到一个 403：
 *   · header 名小写、按名排序、值收尾去空白
 *   · query 按**已编码的**键排序
 *   · 空 query 也要有空行
 */
export function canonicalRequest(input: SignInput): { text: string; signedHeaders: string } {
  const headerEntries = Object.entries(input.headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, " ")] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const canonicalHeaders = headerEntries.map(([k, v]) => `${k}:${v}\n`).join("");
  const signedHeaders = headerEntries.map(([k]) => k).join(";");

  const canonicalQuery = Object.entries(input.query ?? {})
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  return {
    text: [
      input.method.toUpperCase(),
      input.path,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      input.payloadHash,
    ].join("\n"),
    signedHeaders,
  };
}

/**
 * S3 要求的是 RFC3986 编码，而 encodeURIComponent 漏掉了 ! ' ( ) *。
 * 对象名里出现这几个字符的时候会签名不匹配 —— 而备份文件名恰好可能带括号。
 */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function signRequest(input: SignInput): {
  authorization: string;
  signature: string;
  signedHeaders: string;
} {
  const dateStamp = input.amzDate.slice(0, 8);
  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;

  const { text, signedHeaders } = canonicalRequest(input);
  const stringToSign = [ALGORITHM, input.amzDate, scope, sha256Hex(text)].join("\n");

  const kDate = hmac(`AWS4${input.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  return {
    authorization: `${ALGORITHM} Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    signature,
    signedHeaders,
  };
}

/** 20150830T123600Z */
export function amzDate(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}
