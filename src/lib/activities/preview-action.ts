"use server";

import { requireAdmin } from "@/lib/admin/guard";
import { eligiblePreview, type EligiblePreview } from "@/lib/activities/queries";
import { validateRule, type Rule } from "@/lib/activities/eligibility";

/**
 * 规则编辑器的实时预估。
 *
 * 单独一个 "use server" 文件：queries.ts 里还有很多同步导出，
 * 而 "use server" 文件只能导出 async 函数。
 */

export interface PreviewResult {
  ok: boolean;
  error?: string;
  preview?: EligiblePreview;
}

export async function previewEligibility(rule: Rule | null): Promise<PreviewResult> {
  await requireAdmin("activity.manage");

  const check = validateRule(rule);
  // 规则写错时如实报错，而不是给一个「0 人够格」让人以为是门槛太高
  if (!check.ok) return { ok: false, error: check.error };

  return { ok: true, preview: eligiblePreview(rule) };
}
