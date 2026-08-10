"use server";

import { revalidatePath } from "next/cache";

import { requireWritableAdmin } from "@/lib/admin/guard";
import { audit } from "@/lib/audit";

import { lookupGithubLinks } from "@/lib/github/link-lookup";

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

  /*
   * **先问 GitHub，再问模型。**
   *
   * 顺序不能反：反过来的话模型会先把 GitHub 那批链接猜一遍
   * （每条一次调用、一次网络往返），而紧接着来源就会给出一份更准的，
   * 刚才那些钱和时间全白花。
   *
   * 这一步失败不该挡住整理 —— GitHub 挂了或者限流了，
   * 剩下那些非 GitHub 的链接照样该被整理。
   */
  const github = await lookupGithubLinks({ limit }).catch(
    (error: unknown): Awaited<ReturnType<typeof lookupGithubLinks>> => ({
      scanned: 0,
      written: 0,
      gone: 0,
      failed: 0,
      notes: [`GitHub 那一步没跑成：${error instanceof Error ? error.message : String(error)}`],
    }),
  );

  const report = await enrichLinks({ limit });
  if (github.written > 0) {
    report.notes.push(`GitHub 直接答出 ${github.written} 条（没花模型调用）`);
  }
  if (github.gone > 0) {
    report.notes.push(`${github.gone} 条 GitHub 链接已经不在了（删了或转私有）`);
  }
  report.notes.push(...github.notes);

  audit(
    { actorId: admin.user.id },
    {
      action: "links.enrich",
      targetType: "links",
      after: {
        scanned: report.scanned,
        written: report.written,
        unknown: report.unknown,
        githubWritten: github.written,
      },
      reason: `模型整理资源库（${process.env.LLM_MODEL ?? "未知模型"}）`,
    },
  );

  revalidatePath("/links");
  revalidatePath("/admin/llm");
  return { ok: true, ...report };
}
