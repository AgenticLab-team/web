"use server";

import { revalidatePath } from "next/cache";

import { requireWritableAdmin } from "@/lib/admin/guard";
import { audit } from "@/lib/audit";

import { enrichLinks } from "./enrich";

export type EnrichActionResult =
  | { ok: true; scanned: number; written: number; unknown: number; failed: number; notes: string[] }
  | { ok: false; error: string };

/**
 * 手动整理一批。
 *
 * 记审计是因为它**会改动展示给所有人的内容** —— 事后要能回答
 * 「这批简介是什么时候、用哪个模型生成的」。
 */
export async function runEnrichAction(limit = 30): Promise<EnrichActionResult> {
  const admin = await requireWritableAdmin("system.settings");

  const report = await enrichLinks({ limit });

  audit(
    { actorId: admin.user.id },
    {
      action: "links.enrich",
      targetType: "links",
      after: { scanned: report.scanned, written: report.written, unknown: report.unknown },
      reason: `模型整理资源库（${process.env.LLM_MODEL ?? "未知模型"}）`,
    },
  );

  revalidatePath("/links");
  revalidatePath("/admin/llm");
  return { ok: true, ...report };
}
