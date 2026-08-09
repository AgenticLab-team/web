import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EMPTY_PAYLOAD_HASH,
  amzDate,
  canonicalRequest,
  encodeRfc3986,
  sha256Hex,
  signRequest,
} from "@/lib/backup/sigv4";

/**
 * SigV4 对答案。
 *
 * 用的是 AWS 公布的 `get-vanilla` 测试向量 —— 自己实现的签名算法必须
 * 能算出官方那个值，否则每个请求都会 403，而 403 很容易被读成
 * 「密钥填错了」，然后花一下午去查一个根本没错的密钥。
 */

const VECTOR = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
  service: "service",
  amzDate: "20150830T123600Z",
};

describe("AWS 官方测试向量 get-vanilla", () => {
  const input = {
    method: "GET",
    path: "/",
    headers: { Host: "example.amazonaws.com", "X-Amz-Date": "20150830T123600Z" },
    payloadHash: EMPTY_PAYLOAD_HASH,
    ...VECTOR,
  };

  it("规范化请求逐字节对得上", () => {
    const { text, signedHeaders } = canonicalRequest(input);
    assert.equal(
      text,
      [
        "GET",
        "/",
        "",
        "host:example.amazonaws.com",
        "x-amz-date:20150830T123600Z",
        "",
        "host;x-amz-date",
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      ].join("\n"),
    );
    assert.equal(signedHeaders, "host;x-amz-date");
  });

  it("**签名等于官方那个值**", () => {
    const { signature } = signRequest(input);
    assert.equal(signature, "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
  });

  it("Authorization 头的格式也对得上", () => {
    const { authorization } = signRequest(input);
    assert.equal(
      authorization,
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
        "SignedHeaders=host;x-amz-date, " +
        "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  it("空请求体的哈希是那个众所周知的常量", () => {
    assert.equal(
      EMPTY_PAYLOAD_HASH,
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("规范化的细节 —— 每一条错了都只会得到 403", () => {
  const base = {
    method: "PUT",
    path: "/bucket/key",
    payloadHash: EMPTY_PAYLOAD_HASH,
    ...VECTOR,
  };

  it("header 名小写并按名排序", () => {
    const { text } = canonicalRequest({
      ...base,
      headers: { "X-Amz-Date": "d", Host: "h", "Content-Type": "t" },
    });
    const lines = text.split("\n");
    assert.deepEqual(lines.slice(3, 6), ["content-type:t", "host:h", "x-amz-date:d"]);
  });

  it("header 值首尾去空白、内部连续空白折成一个", () => {
    const { text } = canonicalRequest({ ...base, headers: { Host: "  a   b  " } });
    assert.ok(text.includes("host:a b\n"));
  });

  it("query 按已编码的键排序", () => {
    const { text } = canonicalRequest({
      ...base,
      headers: { Host: "h" },
      query: { "list-type": "2", prefix: "a/b", "max-keys": "1000" },
    });
    assert.equal(text.split("\n")[2], "list-type=2&max-keys=1000&prefix=a%2Fb");
  });

  it("没有 query 时那一行是空的，而不是没有那一行", () => {
    const { text } = canonicalRequest({ ...base, headers: { Host: "h" } });
    assert.equal(text.split("\n")[2], "");
    assert.equal(text.split("\n").length, 7);
  });

  it("signedHeaders 和实际签的那些 header 永远一致", () => {
    const { text, signedHeaders } = canonicalRequest({
      ...base,
      headers: { Host: "h", "X-Amz-Content-Sha256": "abc" },
    });
    const listed = signedHeaders.split(";");
    for (const name of listed) {
      assert.ok(text.includes(`${name}:`), `${name} 在 signedHeaders 里但没进规范化请求`);
    }
    assert.deepEqual(listed, ["host", "x-amz-content-sha256"]);
  });
});

describe("RFC3986 编码 —— encodeURIComponent 漏掉的那几个字符", () => {
  it("!'()* 都要编码", () => {
    assert.equal(encodeRfc3986("!'()*"), "%21%27%28%29%2A");
  });

  it("普通字符不动", () => {
    assert.equal(encodeRfc3986("agenticlab-daily-20260809.db.gz"), "agenticlab-daily-20260809.db.gz");
  });

  it("斜杠在 query 值里要编码 —— 前缀带路径时用得上", () => {
    assert.equal(encodeRfc3986("agenticlab/backups/"), "agenticlab%2Fbackups%2F");
  });

  it("中文按 UTF-8 百分号编码", () => {
    assert.equal(encodeRfc3986("备份"), "%E5%A4%87%E4%BB%BD");
  });
});

describe("时间格式", () => {
  it("是 ISO8601 basic，不带连字符冒号毫秒", () => {
    assert.match(amzDate(Date.UTC(2026, 7, 9, 4, 0, 0)), /^\d{8}T\d{6}Z$/);
    assert.equal(amzDate(Date.UTC(2015, 7, 30, 12, 36, 0)), "20150830T123600Z");
  });

  it("前 8 位就是签名作用域里的日期", () => {
    assert.equal(amzDate(Date.UTC(2026, 0, 2, 3, 4, 5)).slice(0, 8), "20260102");
  });
});

describe("哈希", () => {
  it("和 openssl 算出来的一致", () => {
    assert.equal(
      sha256Hex("hello"),
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});
