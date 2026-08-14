import "server-only";

import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { mailDomains } from "@/lib/db/schema";

/** 前台要用的读取。时钟在这一层读完传下去 —— 渲染期读 Date.now() 过不了 React Compiler */

/**
 * 能开一次性箱的域名，给「自己起名字」那个下拉用。
 *
 * 只列**允许自选前缀**的那些开放给下拉 —— 不过滤的话，
 * 用户会选中一个域名、填好名字、点下去才被告知「这个域名不许自选」，
 * 而那时他已经想好名字了。
 */
export function burnerDomains(): { domain: string; allowCustom: boolean }[] {
  return db
    .select({ domain: mailDomains.domain, allowCustom: mailDomains.allowCustomLocal })
    .from(mailDomains)
    .where(and(eq(mailDomains.allowBurner, true), eq(mailDomains.enabled, true)))
    .orderBy(mailDomains.domain)
    .all();
}
