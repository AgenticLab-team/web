import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { env } from "@/lib/env";

import { githubConfigured, isValidTokenKey } from "./oauth-rules";

/**
 * GitHub 的配置与 access token 的加解密。
 *
 * ─────────────────────────────────────────
 * 没配置的时候，这个功能要**整体消失**
 * ─────────────────────────────────────────
 *
 * 不是「按钮还在、点了报错」。一个报错的按钮会被当成站坏了，
 * 而实际上只是站长没配 OAuth App —— 一个用户完全无从判断、
 * 也完全无能为力的状态。所以 config() 返回 null 时：
 * 入口不渲染、路由 404，就像从来没有过这个功能。
 */

export interface GithubConfig {
  clientId: string;
  clientSecret: string;
  tokenKey: string;
}

/** 配齐了就返回配置，没配齐返回 null。**调用方必须处理 null** */
export function githubConfig(): GithubConfig | null {
  const { clientId, clientSecret, tokenKey } = env.github;
  if (!githubConfigured({ clientId, clientSecret, tokenKey })) return null;
  return { clientId, clientSecret, tokenKey };
}

export function githubEnabled(): boolean {
  return githubConfig() !== null;
}

/**
 * token 加密。AES-256-GCM，格式 `v1.<iv>.<tag>.<密文>`，各段 base64url。
 *
 * 用 GCM 而不是 CBC：CBC 只保证「别人读不懂」，不保证「别人改不了」。
 * 库被改过一个字节的话，CBC 会安静地解出一段垃圾并当成 token 发出去，
 * 而 GCM 会直接认证失败 —— 我们要的是后者。
 *
 * iv 每次随机重取。**同一个密钥下 GCM 的 iv 绝不能重复**，
 * 重复一次就同时泄露两条明文，这是 GCM 唯一的致命误用方式。
 */
export function encryptToken(plain: string, keyHex: string): string {
  if (!isValidTokenKey(keyHex)) throw new Error("GITHUB_TOKEN_KEY 不是 32 字节的十六进制串");
  const key = Buffer.from(keyHex, "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), enc.toString("base64url")].join(
    ".",
  );
}

/**
 * 解密。**解不开就返回 null，不抛异常。**
 *
 * 解不开的正常原因只有一个：GITHUB_TOKEN_KEY 换过了。
 * 那时候正确的行为是「这个人的数据刷不了了，等他重新绑一次」，
 * 而不是让他的主页 500 —— 一个换密钥的运维动作
 * 不该表现成一片页面崩溃。
 */
export function decryptToken(payload: string | null, keyHex: string): string | null {
  if (!payload || !isValidTokenKey(keyHex)) return null;
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(keyHex, "hex"),
      Buffer.from(parts[1], "base64url"),
    );
    decipher.setAuthTag(Buffer.from(parts[2], "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(parts[3], "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

/** 生成 state。32 字节随机，撞不上也猜不到 */
export function newState(): string {
  return randomBytes(32).toString("base64url");
}
