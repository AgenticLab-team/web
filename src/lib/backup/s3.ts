import { createHash } from "node:crypto";

import type { OffsiteConfig, RemoteObject } from "@/lib/backup/rules";
import {
  EMPTY_PAYLOAD_HASH,
  amzDate,
  encodeRfc3986,
  sha256Hex,
  signRequest,
} from "@/lib/backup/sigv4";

/**
 * 够用的 S3 客户端：PUT / GET / HEAD / LIST / DELETE。
 *
 * 只做备份需要的那几件事。没有分片上传 —— 备份文件几 MB，
 * 而分片上传的复杂度（以及它失败时留下的半截对象）不值得。
 * 真到了单文件超过几百 MB 的那天再说，那时候的问题也不只是上传方式。
 */

export class S3Error extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "S3Error";
  }
}

export class S3Client {
  constructor(
    private readonly config: OffsiteConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private url(key: string, query?: Record<string, string>): string {
    const path = `/${this.config.bucket}/${key.split("/").map(encodeRfc3986).join("/")}`;
    const qs = query
      ? "?" +
        Object.entries(query)
          .map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`)
          .join("&")
      : "";
    return `${this.config.endpoint}${path}${qs}`;
  }

  private async send(input: {
    method: string;
    key: string;
    query?: Record<string, string>;
    body?: Buffer;
    payloadHash?: string;
    now?: number;
  }): Promise<Response> {
    const host = new URL(this.config.endpoint).host;
    const date = amzDate(input.now ?? Date.now());
    const payloadHash =
      input.payloadHash ?? (input.body ? sha256Hex(input.body) : EMPTY_PAYLOAD_HASH);

    const headers: Record<string, string> = {
      Host: host,
      "x-amz-date": date,
      // 必须签进去：不签的话中间人可以换掉请求体而签名依然有效
      "x-amz-content-sha256": payloadHash,
    };
    if (input.body) headers["content-length"] = String(input.body.length);

    const path = `/${this.config.bucket}/${input.key.split("/").map(encodeRfc3986).join("/")}`;
    const { authorization } = signRequest({
      method: input.method,
      path,
      query: input.query,
      headers,
      payloadHash,
      region: this.config.region,
      service: "s3",
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      amzDate: date,
    });

    const response = await this.fetchImpl(this.url(input.key, input.query), {
      method: input.method,
      headers: { ...headers, Authorization: authorization },
      body: input.body as BodyInit | undefined,
    });

    if (!response.ok && response.status !== 404) {
      const body = await response.text().catch(() => "");
      throw new S3Error(
        `${input.method} ${input.key} 失败：${response.status} ${body.slice(0, 300)}`,
        response.status,
        body,
      );
    }
    return response;
  }

  async put(key: string, body: Buffer, now?: number): Promise<void> {
    await this.send({ method: "PUT", key, body, now });
  }

  async get(key: string, now?: number): Promise<Buffer | null> {
    const response = await this.send({ method: "GET", key, now });
    if (response.status === 404) return null;
    return Buffer.from(await response.arrayBuffer());
  }

  async head(key: string, now?: number): Promise<{ size: number; etag?: string } | null> {
    const response = await this.send({ method: "HEAD", key, now });
    if (response.status === 404) return null;
    return {
      size: Number(response.headers.get("content-length") ?? 0),
      etag: response.headers.get("etag")?.replace(/"/g, ""),
    };
  }

  async delete(key: string, now?: number): Promise<void> {
    await this.send({ method: "DELETE", key, now });
  }

  /**
   * 列出前缀下的对象。
   *
   * 分页要走完 —— 只取第一页的话，超过 1000 个对象之后
   * 「哪些还没传」会算错，而表现是每次都重传同一批文件，
   * 看起来还挺勤快。
   */
  async list(prefix: string, now?: number): Promise<RemoteObject[]> {
    const objects: RemoteObject[] = [];
    let token: string | undefined;

    do {
      const query: Record<string, string> = { "list-type": "2", prefix };
      if (token) query["continuation-token"] = token;

      const response = await this.send({ method: "GET", key: "", query, now });
      const xml = await response.text();

      for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const chunk = match[1];
        const key = chunk.match(/<Key>([\s\S]*?)<\/Key>/)?.[1];
        if (!key) continue;
        objects.push({
          key: decodeXml(key),
          size: Number(chunk.match(/<Size>(\d+)<\/Size>/)?.[1] ?? 0),
          etag: chunk.match(/<ETag>([\s\S]*?)<\/ETag>/)?.[1]?.replace(/&quot;|"/g, ""),
        });
      }

      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
      token = truncated
        ? xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1]
        : undefined;
    } while (token);

    return objects;
  }
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function md5Hex(buffer: Buffer): string {
  return createHash("md5").update(buffer).digest("hex");
}
