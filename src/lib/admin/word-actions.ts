"use server";

import { desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/lib/admin/guard";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { sensitiveWords } from "@/lib/db/schema";
import { checkWord, scanText, type ScanResult, type WordKind } from "@/lib/moderation/words";

/**
 * 敏感词库的写操作与预览。
 *
 * 加词是**低门槛高破坏力**的操作：一个太短或太常见的词，
 * 能在几分钟内把整个论坛变成不可用，而且是**静默**的 ——
 * 没人会来报告「我发不出去帖子」，他们只会不再发帖。
 *
 * 所以这里有两道保险：词条本身的校验（见 words.ts），
 * 以及一个能拿真文本试的预览接口。
 */

export interface WordActionResult {
  ok: boolean;
  error?: string;
}

const fail = (error: string): WordActionResult => ({ ok: false, error });

export async function addWord(input: {
  word: string;
  kind: WordKind;
  replacement?: string;
  reason: string;
}): Promise<WordActionResult> {
  const admin = await requireAdmin("moderation.words");

  if (!input.reason.trim()) return fail("必须填写理由");

  const check = checkWord({
    word: input.word,
    kind: input.kind,
    replacement: input.replacement ?? null,
  });
  if (!check.ok) return fail(check.error!);

  const word = input.word.trim();
  const exists = db.select().from(sensitiveWords).where(eq(sensitiveWords.word, word)).get();
  if (exists) return fail("这个词已经在库里了");

  db.insert(sensitiveWords)
    .values({
      word,
      kind: input.kind,
      replacement: input.kind === "replace" ? (input.replacement?.trim() ?? null) : null,
      createdBy: admin.user.id,
    })
    .run();

  audit({ actorId: admin.user.id }, {
    action: "moderation.words",
    targetType: "word",
    targetId: word,
    after: { kind: input.kind },
    reason: input.reason,
  });

  revalidatePath("/admin/words");
  return { ok: true };
}

export async function updateWord(input: {
  id: string;
  kind: WordKind;
  replacement?: string;
  enabled: boolean;
}): Promise<WordActionResult> {
  const admin = await requireAdmin("moderation.words");

  const row = db.select().from(sensitiveWords).where(eq(sensitiveWords.id, input.id)).get();
  if (!row) return fail("词条不存在");

  const check = checkWord({
    word: row.word,
    kind: input.kind,
    replacement: input.replacement ?? row.replacement,
  });
  if (!check.ok) return fail(check.error!);

  db.update(sensitiveWords)
    .set({
      kind: input.kind,
      replacement: input.kind === "replace" ? (input.replacement?.trim() ?? row.replacement) : null,
      enabled: input.enabled,
    })
    .where(eq(sensitiveWords.id, input.id))
    .run();

  audit({ actorId: admin.user.id }, {
    action: "moderation.words",
    targetType: "word",
    targetId: row.word,
    before: { kind: row.kind, enabled: row.enabled },
    after: { kind: input.kind, enabled: input.enabled },
  });

  revalidatePath("/admin/words");
  return { ok: true };
}

export async function removeWord(input: { id: string; reason: string }): Promise<WordActionResult> {
  const admin = await requireAdmin("moderation.words");
  if (!input.reason.trim()) return fail("必须填写理由");

  const row = db.select().from(sensitiveWords).where(eq(sensitiveWords.id, input.id)).get();
  if (!row) return fail("词条不存在");

  db.delete(sensitiveWords).where(eq(sensitiveWords.id, input.id)).run();

  audit({ actorId: admin.user.id }, {
    action: "moderation.words",
    targetType: "word",
    targetId: row.word,
    before: { kind: row.kind, hits: row.hitCount },
    after: { removed: true },
    reason: input.reason,
  });

  revalidatePath("/admin/words");
  return { ok: true };
}

/**
 * 拿一段真文本试词库。
 *
 * 这是这个页面上最重要的功能。词库是一堆字符串，
 * 光看列表想象不出它会命中什么 —— 尤其是子串误伤：
 * 「三国杀」里的两个字、某个人的昵称、一个常见技术名词。
 * 试一下比想一小时管用。
 */
export async function previewScan(text: string): Promise<{
  ok: boolean;
  result?: ScanResult;
  error?: string;
}> {
  await requireAdmin("moderation.words");

  if (!text.trim()) return { ok: false, error: "先粘一段文本进来" };

  const rules = db
    .select()
    .from(sensitiveWords)
    .orderBy(desc(sensitiveWords.hitCount))
    .all()
    .map((row) => ({
      id: row.id,
      word: row.word,
      kind: row.kind,
      replacement: row.replacement,
      enabled: row.enabled,
    }));

  // 预览不计命中数 —— 试一下就把统计打脏，误伤判断会失真
  return { ok: true, result: scanText(text, rules) };
}
